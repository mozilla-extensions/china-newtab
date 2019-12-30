/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

var EXPORTED_SYMBOLS = ["ChinaNewtabContentSearchParent"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyModuleGetters(this, {
  ContentSearch: "resource:///modules/ContentSearch.jsm",
});
XPCOMUtils.defineLazyGetter(this, "ChinaContentSearch", () => {
  let ChinaContentSearch = Object.create(ContentSearch, ChinaNewtabProperties);
  ChinaContentSearch.init();
  return ChinaContentSearch;
});

var actorsMap = new Map();

var ChinaNewtabProperties = {
  _broadcast: {
    value(type, data) {
      for (let [id, actor] of actorsMap.entries()) {
        try {
          actor.sendAsyncMessage(...this._msgArgs(type, data));
        } catch (ex) {
          actorsMap.delete(id);
          Cu.reportError(ex);
        }
      }
    },
  },
  _reply: {
    value(msg, type, data) {
      if (!Cu.isDeadWrapper(msg.target) && msg.target.browsingContext) {
        let actor = actorsMap.get(msg.target.browsingContext.id);
        actor.sendAsyncMessage(...this._msgArgs(type, data));
      }
    },
  },
};

class ChinaNewtabContentSearchParent extends JSWindowActorParent {
  receiveMessage(msg) {
    // Use `this.manager.browsingContext` instead of `this.browsingContext`
    // for Fx 68 compat, see https://bugzil.la/1557062
    actorsMap.set(this.manager.browsingContext.id, this);

    msg.target = this.manager.browsingContext.embedderElement;
    ChinaContentSearch.receiveMessage(msg);
  }

  didDestroy() {
    if (!this) {
      return;
    }

    actorsMap.delete(this.manager.browsingContext.id);
  }
}
