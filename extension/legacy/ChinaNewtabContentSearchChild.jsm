/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

var EXPORTED_SYMBOLS = ["ChinaNewtabContentSearchChild"];

class ChinaNewtabContentSearchChild extends JSWindowActorChild {
  handleEvent(event) {
    this._sendMsg(event.detail.type, event.detail.data);
  }

  receiveMessage(msg) {
    this._fireEvent(msg.data.type, msg.data.data);
  }

  _sendMsg(type, data = null) {
    this.sendAsyncMessage("ContentSearch", {
      type,
      data,
    });
  }

  _fireEvent(type, data = null) {
    let content = this.document.defaultView;
    let event = Cu.cloneInto(
      {
        detail: {
          type,
          data,
        },
      },
      content
    );
    content.dispatchEvent(
      new content.CustomEvent("ContentSearchService", event)
    );
  }
}
