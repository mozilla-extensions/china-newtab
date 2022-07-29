/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const EVENTS = ["CLICK"];
const SOURCES = ["CARDGRID", "TOP_SITES", "TOP_STORIES"];
const TRACKING_BASE = "https://tracking.firefox.com.cn/china-newtab.gif";

const { actionCreators: ac, actionTypes: at } = ChromeUtils.import(
  "resource://activity-stream/common/Actions.jsm"
);
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyGlobalGetters(this, ["fetch"]);
XPCOMUtils.defineLazyModuleGetters(this, {
  PageThumbs: "resource://gre/modules/PageThumbs.jsm",
});

class ChinaNewtabFeed {
  get pageThumbPrefix() {
    let value = `${PageThumbs.scheme}://${PageThumbs.staticHost}/?`;

    Object.defineProperty(this, "pageThumbPrefix", { value });
    return this.pageThumbPrefix;
  }

  get topSites() {
    let value = this.store.feeds.get("feeds.system.topsites");

    Object.defineProperty(this, "topSites", { value });
    return this.topSites;
  }

  // Generate screenshot even if rich icon or tippytop is available
  async cacheExtraScreenshots(sites) {
    if (!sites || !sites.length) {
      return;
    }

    let pinnedOnly = sites.filter(site => {
      return site && site.isPinned;
    });

    for (let site of pinnedOnly) {
      if (
        site.screenshot &&
        site.screenshot.startsWith &&
        site.screenshot.startsWith(this.pageThumbPrefix)
      ) {
        this.convertScreenshotForWeb(site);
      }
    }

    let withoutScreenshots = pinnedOnly.filter(site => {
      return !site.customScreenshotURL && !site.screenshot;
    });

    if (!withoutScreenshots.length || !this.topSites) {
      return;
    }

    const pinned = await this.topSites.pinnedCache.request();
    for (let site of withoutScreenshots) {
      let link = pinned.find(pin => pin && pin.url === site.url);
      if (!link) {
        continue;
      }

      await this.topSites._fetchScreenshot(link, link.url);
    }
  }

  // Adapted from `Screenshots.getScreenshotForURL`
  // Originally from "resource://activity-stream/lib/Screenshots.jsm"
  async convertScreenshotForWeb(site) {
    let screenshot = null;
    let thumbnailURL = new URL(site.screenshot).searchParams.get("url");
    try {
      const imgPath = PageThumbs.getThumbnailPath(thumbnailURL);

      const filePathResponse = await fetch(`file://${imgPath}`);
      const fileContents = await filePathResponse.blob();

      if (fileContents.size !== 0) {
        screenshot = { path: imgPath, data: fileContents };
      }
    } catch (err) {
      Cu.reportError(`convertScreenshotForWeb(${site.url}) failed: ${err}`);
    }

    this.store.dispatch(
      ac.BroadcastToContent({
        data: { screenshot, url: site.url },
        type: at.SCREENSHOT_UPDATED,
        meta: {
          isStartup: false,
        },
      })
    );
  }

  async onAction(action) {
    switch (action.type) {
      case at.NEW_TAB_INIT:
        // Use NEW_TAB_LOAD and do nothing here?
        break;
      case at.NEW_TAB_INITIAL_STATE:
        let { Prefs, Sections, TopSites } = action.data;

        await this.cacheExtraScreenshots(TopSites.rows);
        if (TopSites.pref) {
          let topSitesRows = TopSites.pref.collapsed
            ? 0
            : Prefs.values.topSitesRows;
          await this.constructor.sendTracking(
            "chinaNewtab",
            "rows",
            "top_sites",
            topSitesRows
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
        await this.constructor.sendTracking(
          "chinaNewtab",
          "rows",
          "top_stories",
          topStoriesRows
        );
        break;
      case at.NEW_TAB_LOAD:
        await this.constructor.sendTracking(
          "chinaNewtab",
          "load",
          "view",
          "activityStream"
        );
        break;
      case at.OPEN_LINK:
        // Nothing to send here for now
        break;
      case at.SCREENSHOT_UPDATED:
        let { screenshot } = action.data;
        if (
          !screenshot ||
          !screenshot.startsWith ||
          !screenshot.startsWith(this.pageThumbPrefix)
        ) {
          break;
        }

        this.convertScreenshotForWeb(action.data);
        break;
      case at.TELEMETRY_USER_EVENT:
        let { action_position, event, source } = action.data;
        if (!EVENTS.includes(event) || !SOURCES.includes(source)) {
          break;
        }

        await this.constructor.sendTracking(
          "chinaNewtab",
          event.toLowerCase(),
          source.toLowerCase(),
          action_position
        );
        break;
      case at.TOP_SITES_PIN:
        await this.constructor.sendTracking(
          "chinaNewtab",
          "saved",
          "top_sites",
          action.data.index
        );
        break;
      case at.TOP_SITES_UPDATED:
        await this.cacheExtraScreenshots(action.data.links);
        break;
      default:
        break;
    }
  }

  // Make this somewhat compatible with `browser.telemetry.recordEvent`?
  static sendTracking(category, method, object, value = "notSet", extra = "") {
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
