/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var EXPORTED_SYMBOLS = ["ChinaNewtabContentThemeChild"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyModuleGetters(this, {
  LightweightThemeChild: "resource:///actors/LightweightThemeChild.jsm",
  Services: "resource://gre/modules/Services.jsm",
});

// Since Fx 72, see https://bugzil.la/1595143
const ChinaNewtabContentThemeChild =
  Services.vc.compare(Services.appinfo.version, "72.0") >= 0 ?
  class ChinaNewtabContentThemeChild extends LightweightThemeChild {} : (
// Copied vanilla implementation starts
/**
 * LightweightThemeChild forwards theme data to in-content pages.
 * It is both instantiated by the traditional Actor mechanism,
 * and also manually within the sidebar JS global (which has no message manager).
 * The manual instantiation is necessary due to Bug 1596852.
 */
class ChinaNewtabContentThemeChild extends JSWindowActorChild {
  constructor() {
    super();
    Services.cpmm.sharedData.addEventListener("change", this);
  }

  didDestroy() {
    Services.cpmm.sharedData.removeEventListener("change", this);
  }

  _getChromeOuterWindowID() {
    // Compat fix, `JSWindowActorChild.docShell` not introduced until Fx 69,
    // see https://bugzil.la/1552263
    const docShell = this.docShell || this.browsingContext.docShell;
    if (docShell.messageManager) {
      return docShell.messageManager.chromeOuterWindowID;
    }
    // We don't have a message manager, so presumable we're running in a sidebar
    // in the parent process.
    return this.contentWindow.top.windowUtils.outerWindowID;
  }

  /**
   * Handles "change" events on the child sharedData map, and notifies
   * our content page if its theme data was among the changed keys.
   */
  handleEvent(event) {
    switch (event.type) {
      // Make sure to update the theme data on first page show.
      case "pageshow":
        this.update();
        break;

      case "change":
        if (
          event.changedKeys.includes(`theme/${this._getChromeOuterWindowID()}`)
        ) {
          this.update();
        }
        break;
    }
  }

  /**
   * Forward the theme data to the page.
   */
  update() {
    const event = Cu.cloneInto(
      {
        detail: {
          data: Services.cpmm.sharedData.get(
            `theme/${this._getChromeOuterWindowID()}`
          ),
        },
      },
      this.contentWindow
    );
    this.contentWindow.dispatchEvent(
      new this.contentWindow.CustomEvent("LightweightTheme:Set", event)
    );
  }
}
// Copied vanilla implementation ends
  );
