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
  ContentSearchParent: "resource:///actors/ContentSearchParent.jsm",
  Services: "resource://gre/modules/Services.jsm",
});

XPCOMUtils.defineLazyGetter(this, "ContentSearch", () => {
  const contentSearchJSM = "resource:///actors/ContentSearchParent.jsm";
  const { ContentSearch } = ChromeUtils.import(contentSearchJSM);
  ContentSearch._reply = (browser, type, data) => {
    if (
      browser.remoteType === "privilegedabout" ||
      // `about:privatebrowsing` is not loaded in `privilegedabout` process
      // until Fx 86, see https://bugzil.la/1687359
      browser.currentURI.prePath === "about:"
    ) {
      browser.sendMessageToActor(type, data, "ContentSearch");
    } else if (
      browser.remoteType === "web" &&
      browser.currentURI.prePath === "https://newtab.firefoxchina.cn"
    ) {
      browser.sendMessageToActor(type, data, "ChinaNewtabContentSearch");
    } else {
      throw new Error("This browser should not access ContentSearch");
    }
  };
  return ContentSearch;
});


var ChinaNewtabContentSearchParent;
if (Services.vc.compare(Services.appinfo.version, "88.0") >= 0) {
  // Since Fx 88, see https://bugzil.la/1697381

  ChinaNewtabContentSearchParent = class extends ContentSearchParent {};
} else {
  ChinaNewtabContentSearchParent = class extends ContentSearchParent {
    receiveMessage(msg) {
      // Access ContentSearch here to trigger the lazy monkey patching
      ContentSearch;
      return super.receiveMessage(msg);
    }
  };
}
