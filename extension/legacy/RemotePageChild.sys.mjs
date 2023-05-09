/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { RemotePageChild } from "resource://gre/actors/RemotePageChild.sys.mjs";

export class ChinaNewtabRemotePageChild extends RemotePageChild {
  exportBaseFunctions() {
    const exportableFunctions = [
      "RPMSendAsyncMessage",
      "RPMAddMessageListener",
    ];

    this.exportFunctions(exportableFunctions);
  }

  exportFunctions(functions) {
    let document = this.document;
    let principal = document.nodePrincipal;

    if (!principal) {
      return;
    }

    let window = this.contentWindow;

    for (let fnname of functions) {
      Cu.exportFunction(this[fnname].bind(this), window, {
        defineAs: fnname,
      });
    }
  }
}
