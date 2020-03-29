const functions = require('firebase-functions');
const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');
const { GeoCollectionReference } = require('geofirestore');
const slack = require('./slack');

admin.initializeApp();
const envVariables = functions.config();

const sgMailApiKey = envVariables && envVariables.sendgrid && envVariables.sendgrid.key
  ? envVariables.sendgrid.key
  : null;

sgMail.setApiKey(sgMailApiKey);

const MAX_RESULTS = 30;
const MAPS_ENABLED = false;
const MINIMUM_NOTIFICATION_DELAY = 20;
const SEND_EMAILS = sgMailApiKey !== null;
const sendingMailsDisabledLogMessage = 'Sending emails is currently disabled.';

exports.offerHelpCreate = functions.region('europe-west1').firestore.document('/ask-for-help/{requestId}/offer-help/{offerId}')
  .onCreate(async (snap) => {
    try {
      const parentPath = snap.ref.parent.path; // get the id
      const offerId = snap.id; // get the id
      const db = admin.firestore();
      const askForHelp = snap.ref.parent.parent;

      const offer = await db.collection(parentPath).doc(offerId).get();
      const askRecord = await askForHelp.get();
      if (!askRecord.exists) {
        console.error('ask-for-help at ', snap.ref.parent.parent.path, 'does not exist');
        return;
      }
      const { request, uid } = askRecord.data().d; // TODO check for d
      const data = await admin.auth().getUser(uid);
      const { email: receiver } = data.toJSON();
      const { answer, email } = offer.data();

      console.log({
        to: receiver,
        from: email,
        templateId: 'd-ed9746e4ff064676b7df121c81037fab',
        dynamic_template_data: {
          subject: 'QuarantäneHelden - Jemand hat dir geschrieben!',
          answer,
          email,
          request,
        },
      });
      try {
        if (SEND_EMAILS) {
          await sgMail.send({
            to: receiver,
            from: 'help@quarantaenehelden.org',
            replyTo: {
              email,
            },
            templateId: 'd-ed9746e4ff064676b7df121c81037fab',
            dynamic_template_data: {
              subject: 'QuarantäneHelden - Jemand hat dir geschrieben!',
              answer,
              email,
              request,
            },
            hideWarnings: true, // removes triple bracket warning
          });
        } else {
          console.log(sendingMailsDisabledLogMessage);
        }
      } catch (err) {
        console.warn(err);
        if (err.response && err.response.body && err.response.body.errors) {
          console.warn(err.response.body.errors);
        }
      }

      await db.collection('/ask-for-help').doc(askRecord.id).update({
        'd.responses': admin.firestore.FieldValue.increment(1),
      });
      await db.collection('/stats').doc('external').update({
        offerHelp: admin.firestore.FieldValue.increment(1),
      });
    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });

exports.sendNotificationEmails = functions.pubsub.schedule('every 3 minutes').onRun(async () => {
  const dist = (search, doc) => Math.abs(Number(search) - Number(doc.plz));

  const db = admin.firestore();

  const getEligibleHelpOffers = async (askForHelpSnapData) => {
    let queryResult = [];
    if (MAPS_ENABLED) {
      const offersRef = new GeoCollectionReference(db.collection('offer-help'));
      const query = offersRef.near({ center: askForHelpSnapData.coordinates, radius: 30 });
      queryResult = (await query.get()).docs.map((doc) => doc.data());
    } else {
      const offersRef = db.collection('offer-help');
      if (!askForHelpSnapData || !askForHelpSnapData.d || !askForHelpSnapData.d.plz) {
        console.warn('Failed to find plz for ask-for-help ', askForHelpSnapData);
      } else {
        const search = askForHelpSnapData.d.plz;
        const start = `${search.slice(0, -3)}000`;
        const end = `${search.slice(0, -3)}999`;
        const results = await offersRef.orderBy('d.plz').startAt(start).endAt(end).get();
        const allPossibleOffers = results.docs
          .map((doc) => ({ id: doc.id, ...doc.data().d }))
          .filter(({ plz }) => plz.length === search.length);
        const sortedOffers = allPossibleOffers
          .map((doc) => ({ ...doc, distance: dist(search, doc) }))
          .sort((doc1, doc2) => doc1.distance - doc2.distance);
        if (sortedOffers.length > MAX_RESULTS) {
          const lastEntry = sortedOffers[MAX_RESULTS];
          queryResult = sortedOffers.filter((doc) => doc.distance <= lastEntry.distance);
        } else {
          queryResult = sortedOffers;
        }
      }
    }

    let offersToContact = [];
    if (queryResult.length > MAX_RESULTS) {
      for (let i = queryResult.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * i);
        const temp = queryResult[i];
        queryResult[i] = queryResult[j];
        queryResult[j] = temp;
      }
      offersToContact = queryResult.slice(0, MAX_RESULTS);
    } else {
      offersToContact = queryResult;
    }
    return offersToContact;
  };

  const sendNotificationEmails = async (eligibleHelpOffers, askForHelpSnapData, askForHelpId) => {
    const result = await Promise.all(eligibleHelpOffers.map(async (offerDoc) => {
      try {
        const { uid } = offerDoc;
        const offeringUser = await admin.auth().getUser(uid);
        const { email } = offeringUser.toJSON();
        await sgMail.send({
          to: email,
          from: 'help@quarantaenehelden.org',
          templateId: 'd-9e0d0ec8eda04c9a98e6cb1edffdac71',
          dynamic_template_data: {
            subject: 'QuarantäneHelden - Jemand braucht deine Hilfe!',
            request: askForHelpSnapData.d.request,
            location: askForHelpSnapData.d.location,
            link: `https://www.quarantaenehelden.org/#/offer-help/${askForHelpId}`,
          },
          hideWarnings: true, // removes triple bracket warning
        });

        await db.collection('/ask-for-help').doc(askForHelpId).update({
          'd.notificationCounter': admin.firestore.FieldValue.increment(1),
          'd.notificationReceiver': admin.firestore.FieldValue.arrayUnion(uid),
        });
        return { askForHelpId, email };
      } catch (err) {
        console.warn(err);
        if (err.response && err.response.body && err.response.body.errors) {
          console.warn(err.response.body.errors);
        }
        return null;
      }
    }));
    console.log(result);
  };

  try {
    const askForHelpSnaps = await db.collection('ask-for-help')
      .where('d.timestamp', '<=', Date.now() - MINIMUM_NOTIFICATION_DELAY * 60 * 1000)
      .where('d.notificationCounter', '==', 0)
      .limit(3)
      .get();

    console.log('askForHelp Requests to execute', askForHelpSnaps.docs.length);
    // RUN SYNC
    const asyncOperations = askForHelpSnaps.docs.map(async (askForHelpSnap) => {
      const askForHelpSnapData = askForHelpSnap.data();
      const askForHelpId = askForHelpSnap.id;
      const eligibleHelpOffers = await getEligibleHelpOffers(askForHelpSnapData);
      console.log('askForHelpId', askForHelpId);
      console.log('eligibleHelpOffers', eligibleHelpOffers.length);
      if (SEND_EMAILS) {
        return sendNotificationEmails(eligibleHelpOffers, askForHelpSnapData, askForHelpId);
      } else {
        console.log(sendingMailsDisabledLogMessage);
      }
    });
    await Promise.all(asyncOperations);
  } catch (e) {
    console.error(e);
  }
});

exports.askForHelpCreate = functions.region('europe-west1').firestore.document('/ask-for-help/{requestId}')
  .onCreate(async (snap) => {
    try {
      const db = admin.firestore();
      const askForHelpId = snap.id; // get the id
      const parentPath = snap.ref.parent.path; // get the id
      const askForHelpSnap = await db.collection(parentPath).doc(askForHelpId).get();
      const askForHelpSnapData = askForHelpSnap.data();

      // Enforce field to 0
      await snap.ref.update({
        'd.notificationCounter': 0,
      });

      await db.collection('/stats').doc('external').update({
        askForHelp: admin.firestore.FieldValue.increment(1),
      });

      await slack.postToSlack(askForHelpId, askForHelpSnapData);
    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });

exports.regionSubscribeCreate = functions.region('europe-west1').firestore.document('/offer-help/{helperId}')
  .onCreate(async (snap) => {
    try {
      const db = admin.firestore();
      await db.collection('/stats').doc('external').update({
        regionSubscribed: admin.firestore.FieldValue.increment(1),
      });
    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });

exports.reportedPostsCreate = functions.region('europe-west1').firestore.document('/reported-posts/{reportRequestId}')
  .onCreate(async (snap) => {
    try {
      const db = admin.firestore();
      const snapValue = snap.data();
      const { askForHelpId, uid } = snapValue;

      // https://cloud.google.com/firestore/docs/manage-data/add-data#update_elements_in_an_array
      await db.collection('/ask-for-help').doc(askForHelpId).update({
        'd.reportedBy': admin.firestore.FieldValue.arrayUnion(uid),
      });
    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });

exports.solvedPostsCreate = functions.region('europe-west1').firestore.document('/solved-posts/{reportRequestId}')
  .onCreate(async (snap) => {
    try {
      const db = admin.firestore();
      const snapValue = snap.data();
      const { uid } = snapValue;
      const askForHelpCollectionName = 'ask-for-help';

      if (!userIdsMatch(db, askForHelpCollectionName, snap.id, uid)) return;

      await migrateResponses(db, askForHelpCollectionName, snap.id, 'solved-posts');
      await deleteDocumentWithSubCollections(db, askForHelpCollectionName, snap.id);
    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });

exports.deletedCreate = functions.region('europe-west1').firestore.document('/deleted/{reportRequestId}')
  .onCreate(async (snap, context) => {
    try {
      const db = admin.firestore();
      const snapValue = snap.data();
      // collectionName can be either "ask-for-help" or "solved-posts"
      const { uid, collectionName } = snapValue;

      if (!userIdsMatch(db, collectionName, snap.id, uid)) return;

      await migrateResponses(db, collectionName, snap.id, 'deleted');
      await deleteDocumentWithSubCollections(db, collectionName, snap.id);
    } catch (e) {
      console.error(e);
      console.log('ID', snap.id);
    }
  });

async function userIdsMatch(db, collectionName, documentId, uidFromRequest) {
  const docSnap = await db.collection(collectionName).doc(documentId).get();
  const docSnapData = docSnap.data();
  const { uid } = docSnapData;
  return uid === uidFromRequest;
}

async function migrateResponses(db, collectionToMigrateFrom, documentId, collectionToMigrateTo) {
  const responsesSnap = await db.collection(collectionToMigrateFrom).doc(documentId).collection('offer-help').get();
  const responses = responsesSnap.docs.map((docSnapshot) => ({ ...docSnapshot.data(), id: docSnapshot.id }));

  const batch = db.batch();
  const subCollection = db.collection(collectionToMigrateTo).doc(documentId).collection('offer-help');
  responses.map((response) => batch.set(subCollection.doc(response.id), response));
  await batch.commit();
}

async function deleteDocumentWithSubCollections(db, collectionName, documentId) {
  // delete document from collection
  await db.collection(collectionName).doc(documentId).delete();
  // recursive delete to remove the sub collections (e.g. responses) as well
  const collectionPath = `${collectionName}/${documentId}/offer-help`;
  const batchSize = 50;
  return deleteCollection(db, collectionPath, batchSize)
}

// db-admins API does not support recursive deletion yet, which is necessary to delete subcollections of a document
// https://github.com/firebase/firebase-admin-node/issues/361
async function deleteCollection(db, collectionPath, batchSize) {
  // code taken from https://firebase.google.com/docs/firestore/manage-data/delete-data#collections
  let collectionRef = db.collection(collectionPath);
  let query = collectionRef.orderBy('__name__').limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(db, query, resolve, reject);
  });
}

async function deleteQueryBatch(db, query, resolve, reject) {
  // code taken from https://firebase.google.com/docs/firestore/manage-data/delete-data#collections
  return query.get()
    .then((snapshot) => {
      // When there are no documents left, we are done
      if (snapshot.size === 0) {
        return 0;
      }

      // Delete documents in a batch
      let batch = db.batch();
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      return batch.commit().then(() => {
        return snapshot.size;
      });
    }).then((numDeleted) => {
      if (numDeleted === 0) {
        resolve();
        return;
      }

      // Recurse on the next process tick, to avoid
      // exploding the stack.
      process.nextTick(() => {
        deleteQueryBatch(db, query, resolve, reject);
      });
    })
    .catch(reject);
}
