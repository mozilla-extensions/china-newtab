/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

var EXPORTED_SYMBOLS = ["ChinaNewtabContentSearchChild"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyModuleGetters(this, {
  ContentSearchChild: "resource:///actors/ContentSearchChild.jsm",
  Services: "resource://gre/modules/Services.jsm",
});

// Since Fx 77, see https://bugzil.la/1614738
const ChinaNewtabContentSearchChild =
  Services.vc.compare(Services.appinfo.version, "77.0") >= 0 ?
  class ChinaNewtabContentSearchChild extends ContentSearchChild {} : (
// Copied vanilla implementation starts
class ChinaNewtabContentSearchChild extends JSWindowActorChild {
  handleEvent(event) {
    // The event gets translated into a message that
    // is then sent to the parent.
    if (event.type == "ContentSearchClient") {
      // Compat fix, try both message styles, before one is determined
      if (this.umbrellaMsgName !== true) {
        this.sendAsyncMessage(event.detail.type, event.detail.data);
      }
      if (this.umbrellaMsgName !== false) {
        this.sendAsyncMessage("ContentSearch", {
          type: event.detail.type,
          data: event.detail.data,
        });
      }
    }
  }

  receiveMessage(msg) {
    // Compat fix, prefer old style message, but keep handling the new style
    if (msg.name === "ContentSearch") {
      this.umbrellaMsgName = true;
      this._fireEvent(msg.data.type, msg.data.data);
      return;
    }
    this.umbrellaMsgName = false;

    // The message gets translated into an event that
    // is then sent to the content.
    this._fireEvent(msg.name, msg.data);
  }

  _fireEvent(type, data = null) {
    let event = Cu.cloneInto(
      {
        detail: {
          type,
          data,
        },
      },
      this.contentWindow
    );
    this.contentWindow.dispatchEvent(
      new this.contentWindow.CustomEvent("ContentSearchService", event)
    );
  }
}
// Copied vanilla implementation ends
  );
