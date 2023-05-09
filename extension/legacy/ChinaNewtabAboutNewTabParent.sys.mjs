/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AboutNewTabParent } from "resource:///actors/AboutNewTabParent.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

XPCOMUtils.defineLazyModuleGetters(lazy, {
  ChinaNewtabFeedInit: "resource://china-newtab/ChinaNewtabFeed.jsm",
});

export class ChinaNewtabAboutNewTabParent extends AboutNewTabParent {
  actorCreated() {
    lazy.ChinaNewtabFeedInit();
  }
}
