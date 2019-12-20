/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const EVENTS = [
  "BLOCK",
  "CLICK",
  "MENU_COLLAPSE",
  "MENU_EXPAND",
  "MOCOCN_LESS_ROWS",
  "MOCOCN_MORE_ROWS",
  "OPEN_NEW_WINDOW",
  "OPEN_PRIVATE_WINDOW",
  "UNPIN",
];
const SOURCES = ["TOP_SITES", "TOP_STORIES"];
const TRACKING_BASE = "https://tracking.firefox.com.cn/china-newtab.gif";

const { actionTypes: at } = ChromeUtils.import(
  "resource://activity-stream/common/Actions.jsm"
);
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyGlobalGetters(this, ["fetch"]);

class ChinaNewtabFeed {
  async onAction(action) {
    switch (action.type) {
      case at.NEW_TAB_INIT:
        // Use NEW_TAB_LOAD and do nothing here?
        break;
      case at.NEW_TAB_INITIAL_STATE:
        let { Prefs, Sections, TopSites } = action.data;

        if (TopSites.pref) {
          let topSitesRows = TopSites.pref.collapsed
                           ? 0
                           : Prefs.values.topSitesRows;
          await this.sendTracking(
            "chinaNewtab",
            "rows",
            "top_sites",
            topSitesRows,
          );
        }

        let topStories = Sections.filter(
          section => section.id === "topstories"
        )[0];
        if (!topStories) {
          break;
        }
        let topStoriesRows = topStories.pref.collapsed
                           ? 0
                           : Prefs.values["section.topstories.rows"];
        await this.sendTracking(
          "chinaNewtab",
          "rows",
          "top_stories",
          topStoriesRows,
        );
        break;
      case at.NEW_TAB_LOAD:
        await this.sendTracking(
          "chinaNewtab",
          "load",
          "view",
          "activityStream",
        );
        break;
      case at.OPEN_LINK:
        // Nothing to send here for now
        break;
      case at.TELEMETRY_USER_EVENT:
        let { action_position, event, source } = action.data;
        if (!EVENTS.includes(event) || !SOURCES.includes(source)) {
          break;
        }

        await this.sendTracking(
          "chinaNewtab",
          event.toLowerCase(),
          source.toLowerCase(),
          action_position,
        );
        break;
      case at.TOP_SITES_PIN:
        await this.sendTracking(
          "chinaNewtab",
          "saved",
          "top_sites",
          action.data.index,
        );
        break;
      default:
        break;
    }
  }

  // Make this somewhat compatible with `browser.telemetry.recordEvent`?
  async sendTracking(category, method, object, value = "notSet", extra = "") {
    let url = new URL(TRACKING_BASE);
    url.searchParams.append("c", category);
    url.searchParams.append("t", object);
    url.searchParams.append("a", method);
    url.searchParams.append("d", value.toString());
    url.searchParams.append("f", extra);
    url.searchParams.append("r", Math.random());
    url.searchParams.append("cid", "");
    return fetch(url);
  }
}

const EXPORTED_SYMBOLS = ["ChinaNewtabFeed"];
