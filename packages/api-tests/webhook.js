
class WebhookListener {
  constructor(webhookConfig) {
    this.webhookConfig = webhookConfig;
    this.recordings = new Map();
    this.finalizeCallbacks = new Set();

    this.readyPromise = new Promise((resolveReadyPromise, rejectReadyPromise) => {
      if (this.webhookConfig.type == 'google-pubsub') {
        this._setupGooglePubsubSubscription().then(subscription => resolveReadyPromise(subscription)).catch(err => rejectReadyPromise(err));
      }
      else if (this.webhookConfig.type == 'appengine') {
        this._setupAppengineSubscription().then(subscription => resolveReadyPromise(subscription)).catch(err => rejectReadyPromise(err));
      }
      else {
        rejectReadyPromise(new Error(`Unable to initialize webhook of type "${this.webhookConfig.type}".`));
      }
    });
  }

  get ready() {
    return this.readyPromise;
  }

  startRecording() {
    const handle = Symbol();
    const recording = new WebhookRecording(() => this.recordings.delete(handle));
    this.recordings.set(handle, recording);
    return recording;
  }

  finalize() {
    for (const finalizeCallback of this.finalizeCallbacks) {
      finalizeCallback();
    }
  }

  _processRecordings(body, simpleHeaders, rawHeaders, metaData) {
    for (const recording of this.recordings.values()) {
      recording.addRecord({ body, simpleHeaders, rawHeaders, metaData });
    }
  }

  async _setupGooglePubsubSubscription() {
    const { getGooglePubsubSubscription } = require('./webhooks/google-cloud-functions/subscription.js');
    this.googlePubsubSubscription = await getGooglePubsubSubscription(this.webhookConfig.projectId, this.webhookConfig.topicId, this.webhookConfig.credentials);

    this.googlePubsubSubscription.on('message', message => {
      message.ack();
      const msgData = JSON.parse(message.data);

      if ((! 'webhookId' in msgData) || !msgData.webhookId.startsWith(this.webhookConfig.webhookId)) {
        // Only process messages that where meant for our tenant.
        return;
      }

      const body = msgData.bodyIsHex ? Buffer.fromString(msgData.body, 'hex') : msgData.body;

      const metaData = {
        pubsubMessageId: message.id,
        webhookId: msgData.webhookId,
      };

      this._processRecordings(body, msgData.headers, msgData.rawHeaders, metaData);
    });

    this.finalizeCallbacks.add(() => {
      this.googlePubsubSubscription.removeAllListeners();
      this.googlePubsubSubscription.close();
    });

    return this.googlePubsubSubscription;
  }

  async _setupAppengineSubscription() {
    const { getAppengineSubscription } = require('./webhooks/appengine/subscription.js');
    this.appengineSubscription = await getAppengineSubscription(this.webhookConfig.wsUrl);

    this.appengineSubscription.on('message', message => {
      const msgData = JSON.parse(message);

      const body = msgData.bodyIsHex ? Buffer.fromString(msgData.body, 'hex') : msgData.body;

      this._processRecordings(body, msgData.headers, msgData.rawHeaders, {});
    });

    this.finalizeCallbacks.add(() => {
      this.appengineSubscription.removeAllListeners();
      this.appengineSubscription.terminate();
    });

    return this.appengineSubscription;
  }
}


class WebhookRecording {
  constructor(stopCallback) {
    this.stopCallback = stopCallback;
    this.records = [];
    this.matchers = new Map();
    this.allMatchedCallbacks = new Set();
  }

  async addRecord(record) {
    this.records.push(record);
    await this._matchRecord(record);
    if (this._areAllMatchersSatisfied()) {
      // Copy allMatchedCallbacks because some callbacks might remove themselves from the set during iteration.
      const allMatchedCallbacks = Array.from(this.allMatchedCallbacks.values());
      allMatchedCallbacks.forEach(allMatchedCallback => allMatchedCallback());
    }
  }

  addMatcher(matcher) {
    this.matchers.set(matcher, false);
  }

  async _matchRecord(record) {
    for (const [matcher, previousResult] of this.matchers.entries()) {
      if (! previousResult && ! record.wasMatched) {
        let result = matcher(record.body, record.simpleHeaders, record.rawHeaders, record.metaData);
        // Allow for both `async` and non-`async` matcher functions:
        result = result instanceof Promise ? await result : result;
        if (result) {
          this.matchers.set(matcher, true); // Let each matcher match only once.
          record.wasMatched = true; // Match each record only once.
        }
      }
    }
  }

  _areAllMatchersSatisfied() {
    return Array.from(this.matchers.values()).reduce((accumulator, currentValue) => accumulator && currentValue, true);
  }

  areAllMatched(timeOut) {
    this.records.forEach(record => this._matchRecord(record));
    return new Promise((resolveAllMatchedPromise, rejectAllMatchedPromise) => {
      if (this._areAllMatchersSatisfied()) {
        resolveAllMatchedPromise(true);
      }
      else {
        const timeoutID = setTimeout(() => rejectAllMatchedPromise(false), timeOut);
        let allMatchedCallback;
        allMatchedCallback = () => {
          clearTimeout(timeoutID);
          this.allMatchedCallbacks.delete(allMatchedCallback);
          resolveAllMatchedPromise(true);
        }
        this.allMatchedCallbacks.add(allMatchedCallback);
      }
    });
  }

  stop() {
    this.stopCallback();
  }
}


// For test configs without webhook config.
class DummyWebhookRecording {
  constructor() {}

  addMatcher(matcher) {}

  areAllMatched(timeOut) {
    return Promise.resolve(true);
  }

  stop() {}
}


module.exports = {
  WebhookListener, DummyWebhookRecording
};
