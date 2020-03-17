const axios = require('axios');

exports.postToSlack = function postToSlack(snapId, snapData) {
    axios({
        method: 'POST',
        url: 'https://hooks.slack.com/services/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',
        headers: {
            'Content-type': 'application/json'
        },
        data: {
            text: `https://www.quarantaenehelden.org/#/offer-help/${snapId}\n>${snapData.d.request.replace('\n', '\n>')}`
        }
    });
};
