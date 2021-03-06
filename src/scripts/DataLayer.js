/*
Copyright 2019 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const cloneDeep = require('lodash/cloneDeep');
const cloneDeepWith = require('lodash/cloneDeepWith');
const isObject = require('lodash/isObject');
const isArray = require('lodash/isArray');
const reject = require('lodash/reject');
const mergeWith = require('lodash/mergeWith');
const assign = require('lodash/assign');
const isNull = require('lodash/isNull');
const get = require('lodash/get');

/**
 * Data Layer.
 *
 * @type {Object}
 */
const DataLayer = {};
DataLayer.Item = require('./DataLayerItem').item;
DataLayer.Listener = require('./DataLayerListener');
DataLayer.ListenerManagerFactory = require('./DataLayerListenerManagerFactory');
DataLayer.constants = require('./DataLayerConstants');

/**
 * @typedef  {Object} ListenerOnConfig
 * @property {String} on Name of the event to bind to.
 * @property {String} [path] Object key in the state to bind to.
 * @property {ListenerScope} [scope] Scope of the listener.
 * @property {Function} handler Handler to execute when the bound event is triggered.
 */

/**
 * @typedef  {Object} ListenerOffConfig
 * @property {String} off Name of the event to unbind.
 * @property {String} [path] Object key in the state to bind to.
 * @property {ListenerScope} [scope] Scope of the listener.
 * @property {Function} [handler] Handler for a previously attached event to unbind.
 */

/**
 * @typedef {Object} DataConfig
 * @property {Object} data Data to be updated in the state.
 */

/**
 * @typedef {Object} EventConfig
 * @property {String} event Name of the event.
 * @property {Object} [eventInfo] Additional information to pass to the event handler.
 * @property {DataConfig.data} [data] Data to be updated in the state.
 */

/**
 * @typedef {DataConfig | EventConfig | ListenerOnConfig | ListenerOffConfig} ItemConfig
 */

/**
 * Manager
 *
 * @class Manager
 * @classdesc Data Layer manager that augments the passed data layer array and handles eventing.
 * @param {Object} config The Data Layer manager configuration.
 */
DataLayer.Manager = function DataLayer(config) {
  const that = this;

  that._config = config;
  that._initialize();
};

/**
 * Initializes the data layer.
 *
 * @private
 */
DataLayer.Manager.prototype._initialize = function() {
  const that = this;

  if (!Array.isArray(that._config.dataLayer)) {
    that._config.dataLayer = [];
  }

  that._dataLayer = that._config.dataLayer;
  that._state = {};
  that._previousStateCopy = {};
  that._listenerManager = DataLayer.ListenerManagerFactory.create(that);

  that._augment();
  that._processItems();
};

/**
 * Updates the state with the item.
 *
 * @param {Item} item The item.
 * @private
 */
DataLayer.Manager.prototype._updateState = function(item) {
  this._previousStateCopy = cloneDeep(this._state);
  this._customMerge(this._state, item.data);
};

/**
 * Merges the source into the object and sets objects as 'undefined' if they are 'undefined' in the source object.
 *
 * @param {Object} object The object into which to merge.
 * @param {Object} source The source to merge with.
 * @private
 */
DataLayer.Manager.prototype._customMerge = function(object, source) {
  const omitDeep = function(value, predicate = (val) => !val) {
    return cloneDeepWith(value, makeOmittingCloneDeepCustomizer(predicate));
  };

  const makeOmittingCloneDeepCustomizer = function(predicate) {
    return function omittingCloneDeepCustomizer(value, key, object, stack) {
      if (isObject(value)) {
        if (isArray(value)) {
          return reject(value, predicate).map(item => cloneDeepWith(item, omittingCloneDeepCustomizer));
        }

        const clone = {};
        for (const subKey of Object.keys(value)) {
          if (!predicate(value[subKey])) {
            clone[subKey] = cloneDeepWith(value[subKey], omittingCloneDeepCustomizer);
          }
        }
        return clone;
      }
      return undefined;
    };
  };

  const customizer = function(objValue, srcValue, key, object) {
    if (typeof srcValue === 'undefined' || srcValue === null) {
      return null;
    }
  };

  mergeWith(object, source, customizer);

  // Remove null or undefined objects
  assign(object, omitDeep(object, isNull));
};

/**
 * Augments the data layer Array Object, overriding push() and adding getState().
 *
 * @private
 */
DataLayer.Manager.prototype._augment = function() {
  const that = this;

  /**
   * Pushes one or more items to the data layer.
   *
   * @param {...ItemConfig} var_args The items to add to the data layer.
   * @returns {Number} The length of the data layer following push.
   */
  that._dataLayer.push = function(var_args) { /* eslint-disable-line camelcase */
    const pushArguments = arguments;
    const filteredArguments = arguments;

    Object.keys(pushArguments).forEach(function(key) {
      const itemConfig = pushArguments[key];
      const item = new DataLayer.Item(itemConfig);

      if (!item.valid) {
        delete filteredArguments[key];
      }
      switch (item.type) {
        case DataLayer.constants.itemType.DATA:
        case DataLayer.constants.itemType.EVENT: {
          that._processItem(item);
          break;
        }
        case DataLayer.constants.itemType.FCTN: {
          delete filteredArguments[key];
          that._processItem(item);
          break;
        }
        case DataLayer.constants.itemType.LISTENER_ON:
        case DataLayer.constants.itemType.LISTENER_OFF: {
          delete filteredArguments[key];
        }
      }
    });

    if (filteredArguments[0]) {
      return Array.prototype.push.apply(this, filteredArguments);
    }
  };

  /**
   * Returns a deep copy of the data layer state or of the object defined by the path.
   *
   * @param {Array|String} path The path of the property to get.
   * @returns {*} Returns a deep copy of the resolved value if a path is passed, a deep copy of the data layer state otherwise.
   */
  that._dataLayer.getState = function(path) {
    if (path) {
      return get(cloneDeep(that._state), path);
    }
    return cloneDeep(that._state);
  };

  /**
   * Sets up a function that will be called whenever the specified event is triggered.
   *
   * @param {String} type A case-sensitive string representing the event type to listen for.
   * @param {Function} listener A function that is called when the event of the specified type occurs.
   * @param {Object} [options] Optional characteristics of the event listener. Available options:
   *   - {String} path The path of the object to listen to.
   *   - {String} scope The listener scope. Possible values:
   *      - {String} past The listener is triggered for past events.
   *      - {String} future The listener is triggered for future events.
   *      - {String} all The listener is triggered for past and future events (default value).
   */
  that._dataLayer.addEventListener = function(type, listener, options) {
    const eventListenerItem = new DataLayer.Item({
      on: type,
      handler: listener,
      scope: options && options.scope,
      path: options && options.path
    });

    that._processItem(eventListenerItem);
  };

  /**
   * Removes an event listener previously registered with addEventListener().
   *
   * @param {String} type A case-sensitive string representing the event type to listen for.
   * @param {Function} [listener] Optional function that is to be removed.
   */
  that._dataLayer.removeEventListener = function(type, listener) {
    const eventListenerItem = new DataLayer.Item({
      off: type,
      handler: listener
    });

    that._processItem(eventListenerItem);
  };
};

/**
 * Processes all items that already exist on the stack.
 *
 * @private
 */
DataLayer.Manager.prototype._processItems = function() {
  const that = this;

  for (let i = 0; i < that._dataLayer.length; i++) {
    const item = new DataLayer.Item(that._dataLayer[i], i);

    that._processItem(item);

    // remove event listener or invalid item from the data layer array
    if (item.type === DataLayer.constants.itemType.LISTENER_ON ||
      item.type === DataLayer.constants.itemType.LISTENER_OFF ||
      item.type === DataLayer.constants.itemType.FCTN ||
      !item.valid) {
      that._dataLayer.splice(i, 1);
      i--;
    }
  }
};

/**
 * Processes an item pushed to the stack.
 *
 * @param {Item} item The item to process.
 * @private
 */
DataLayer.Manager.prototype._processItem = function(item) {
  const that = this;

  if (!item.valid) {
    const message = 'The following item cannot be handled by the data layer ' +
      'because it does not have a valid format: ' +
      JSON.stringify(item.config);
    console.error(message);
    return;
  }

  /**
   * Returns all items before the provided one.
   *
   * @param {Item} item The item.
   * @returns {Array<Item>} The items before.
   * @private
   */
  function _getBefore(item) {
    if (!(that._dataLayer.length === 0 || item.index > that._dataLayer.length - 1)) {
      return that._dataLayer.slice(0, item.index).map(itemConfig => new DataLayer.Item(itemConfig));
    }
    return [];
  }

  const typeProcessors = {
    data: function(item) {
      that._updateState(item);
      that._listenerManager.triggerListeners(item);
    },
    fctn: function(item) {
      item._config.call(that._dataLayer, that._dataLayer);
    },
    event: function(item) {
      if (item.data) {
        that._updateState(item);
      }
      that._listenerManager.triggerListeners(item);
    },
    listenerOn: function(item) {
      const listener = new DataLayer.Listener(item);
      switch (listener.scope) {
        case DataLayer.constants.listenerScope.PAST: {
          for (const registeredItem of _getBefore(item)) {
            that._listenerManager.triggerListener(listener, registeredItem);
          }
          break;
        }
        case DataLayer.constants.listenerScope.FUTURE: {
          that._listenerManager.register(listener);
          break;
        }
        case DataLayer.constants.listenerScope.ALL: {
          const registered = that._listenerManager.register(listener);
          if (registered) {
            for (const registeredItem of _getBefore(item)) {
              that._listenerManager.triggerListener(listener, registeredItem);
            }
          }
        }
      }
    },
    listenerOff: function(item) {
      that._listenerManager.unregister(new DataLayer.Listener(item));
    }
  };

  typeProcessors[item.type](item);
};

new DataLayer.Manager({
  dataLayer: window.adobeDataLayer
});

/**
 * Triggered when there is change in the data layer state.
 *
 * @event DataLayerEvent.CHANGE
 * @type {Object}
 * @property {Object} data Data pushed that caused a change in the data layer state.
 */

/**
 * Triggered when an event is pushed to the data layer.
 *
 * @event DataLayerEvent.EVENT
 * @type {Object}
 * @property {String} name Name of the committed event.
 * @property {Object} eventInfo Additional information passed with the committed event.
 * @property {Object} data Data that was pushed alongside the event.
 */

/**
 * Triggered when an arbitrary event is pushed to the data layer.
 *
 * @event <custom>
 * @type {Object}
 * @property {String} name Name of the committed event.
 * @property {Object} eventInfo Additional information passed with the committed event.
 * @property {Object} data Data that was pushed alongside the event.
 */

/**
 * Triggered when the data layer has initialized.
 *
 * @event DataLayerEvent.READY
 * @type {Object}
 */

module.exports = DataLayer;
