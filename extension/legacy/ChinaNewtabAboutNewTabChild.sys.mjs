/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChinaNewtabRemotePageChild } from "resource://china-newtab/RemotePageChild.sys.mjs";

let gNextPortID = 0;

export class ChinaNewtabAboutNewTabChild extends ChinaNewtabRemotePageChild {
  handleEvent(event) {
    if (event.type == "DOMDocElementInserted") {
      let portID = Services.appinfo.processID + ":" + ++gNextPortID;

      this.sendAsyncMessage("Init", {
        portID,
        url: this.contentWindow.document.documentURI.replace(/[\#|\?].*$/, ""),
      });
    } else if (event.type == "load") {
      this.sendAsyncMessage("Load");
    } else if (event.type == "unload") {
      try {
        this.sendAsyncMessage("Unload");
      } catch (e) {}
    }
  }
}
