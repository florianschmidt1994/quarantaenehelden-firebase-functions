const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(
  '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',
);

exports.firestoreRequest = functions.region('europe-west1').firestore.document('/ask-for-help/{requestId}/offer-help/{offerId}')
  .onCreate(async (snap, context) => {

    const parentPath = snap.ref.parent.path; // get the id
    const offerId = snap.id; // get the id
    const db = admin.firestore();
    const askForHelp = snap.ref.parent.parent;

    const offer = await db.collection(parentPath).doc(offerId).get();
    const askRecord = await askForHelp.get();
    const { request, uid } = askRecord.data().d;
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
        request
      }
    })
    return await sgMail.send({
      to: receiver,
      from: email,
      templateId: 'd-ed9746e4ff064676b7df121c81037fab',
      dynamic_template_data: {
        subject: 'QuarantäneHelden - Jemand hat dir geschrieben!',
        answer,
        email,
        request
      }
    });
  });
