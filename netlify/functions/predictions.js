const { getStore } = require('@netlify/blobs');

exports.handler = async function () {
  try {
    const store = getStore('hrdemons');
    let payload = await store.get('latest', { type: 'json' });

    if (!payload) {
      // First visit after deploy: create data immediately.
      const mod = require('./updatePredictions.js');
      const res = await mod.handler();
      return res;
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(payload)
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
