/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

var EXPORTED_SYMBOLS = ["ChinaNewtabContentThemeParent"];

class ChinaNewtabContentThemeParent extends JSWindowActorParent {
  receiveMessage(msg) {
    try {
      let browser = msg.target.manager.browsingContext.embedderElement;
      return browser.ownerGlobal.windowUtils.outerWindowID;
    } catch (ex) {
      // Will this happen ?
      Cu.reportError(ex);
      return 1;
    }
  }
}
