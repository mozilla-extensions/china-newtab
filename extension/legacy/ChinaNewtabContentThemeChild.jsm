/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

var EXPORTED_SYMBOLS = ["ChinaNewtabContentThemeChild"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

class ChinaNewtabContentThemeChild extends JSWindowActorChild {
  constructor() {
    super();

    Services.cpmm.sharedData.addEventListener("change", this);
  }

  didDestroy() {
    if (!this) {
      return;
    }

    Services.cpmm.sharedData.removeEventListener("change", this);
  }

  async handleEvent(event) {
    let outerWindowId = await this.sendQuery("ChinaNewtabOuterWindowId");
    switch (event.type) {
      case "change":
        if (event.changedKeys.includes(`theme/${outerWindowId}`)) {
          this.update(outerWindowId, this.document.defaultView);
        }
        break;
      case "pageshow":
        this.update(outerWindowId, this.document.defaultView);
        break;
      default:
        break;
    }
  }

  update(outerWindowID, content) {
    const event = Cu.cloneInto(
      {
        detail: {
          data: Services.cpmm.sharedData.get(`theme/${outerWindowID}`),
        },
      },
      content
    );
    content.dispatchEvent(
      new content.CustomEvent("LightweightTheme:Set", event)
    );
  }
}
