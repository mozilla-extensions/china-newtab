/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const NEWTAB_URL = "https://newtab.firefoxchina.cn/newtab/as/activity-stream.html";
const RESOURCE_HOST = "china-newtab";

/* global ExtensionAPI, XPCOMUtils */
XPCOMUtils.defineLazyModuleGetters(this, {
  AboutNewTab: "resource:///modules/AboutNewTab.jsm",
  ChinaNewtabFeed: `resource://${RESOURCE_HOST}/ChinaNewtabFeed.jsm`,
  NewTabUtils: "resource://gre/modules/NewTabUtils.jsm",
  RemotePageManager: "resource://gre/modules/remotepagemanager/RemotePageManagerParent.jsm",
  RemotePages: "resource://gre/modules/remotepagemanager/RemotePageManagerParent.jsm",
  SectionsManager: "resource://activity-stream/lib/SectionsManager.jsm",
  Services: "resource://gre/modules/Services.jsm",
  TelemetryTimestamps: "resource://gre/modules/TelemetryTimestamps.jsm",
});
XPCOMUtils.defineLazyGlobalGetters(this, ["URL", "fetch"]);

XPCOMUtils.defineLazyServiceGetter(
  this,
  "aboutNewTabService",
  "@mozilla.org/browser/aboutnewtab-service;1",
  "nsIAboutNewTabService"
);
XPCOMUtils.defineLazyServiceGetter(
  this,
  "resProto",
  "@mozilla.org/network/protocol;1?name=resource",
  "nsISubstitutingProtocolHandler"
);

this.activityStreamHack = {
  newTabURL: null,

  init(extension) {
    this.newTabURL = extension.baseURI.resolve("newtab/newtab.html");

    this.initNewTabOverride();
    this.initPrefs();
    this.initRemotePages();
  },

  initNewTabOverride() {
    // Since Fx 76, see https://bugzil.la/1619992
    this.overrideNewtab(AboutNewTab.newTabURL || aboutNewTabService.newTabURL);

    Services.obs.addObserver(this, "newtab-url-changed");
  },

  initPrefs() {
    // Store some of the prefs in a WebExtension aware way so they're reverted on disable/uninstall?
    let currentVersion = Services.prefs.getIntPref("extensions.chinaNewtab.prefVersion", 0);
    let prefsToSet = new Map();
    switch (currentVersion) {
      case 0:
        for (let [key, val] of [
          ["browser.newtabpage.activity-stream.discoverystream.config", JSON.stringify({
            "collapsible": true,
            "enabled": false,
            "show_spocs": false,
            "hardcoded_layout": false,
            "personalized": false,
            "layout_endpoint": "https://newtab.firefoxchina.cn/newtab/ds/china-basic.json",
          })],
          ["browser.newtabpage.activity-stream.discoverystream.enabled", false],
          ["browser.newtabpage.activity-stream.discoverystream.endpoints", [
            "https://getpocket.cdn.mozilla.net/",
            "https://spocs.getpocket.com/",
            "https://api2.firefoxchina.cn/",
            "https://newtab.firefoxchina.cn/",
          ].join(",")],
          ["browser.newtabpage.activity-stream.feeds.aboutpreferences", false],
          ["browser.newtabpage.activity-stream.feeds.section.topstories.options", JSON.stringify({
            hidden: false,
            provider_icon: "highlights",
            provider_name: "\u65b0\u95fb",
            read_more_endpoint: "",
            stories_endpoint: "https://api2.firefoxchina.cn/newtab/hot_news.json",
            stories_referrer: "",
            topics_endpoint: "",
            show_spocs: false,
            personalized: true,
          })],
          ["browser.newtabpage.activity-stream.improvesearch.topSiteSearchShortcuts", false],
          ["browser.newtabpage.activity-stream.section.topstories.rows", 3],
          ["browser.newtabpage.activity-stream.topSitesRows", 2],
          ["extensions.chinaNewtab.prefVersion", 1],
          // Disable appcache based offlintab from cehomepage
          ["moa.ntab.openInNewTab", false],
        ]) {
          prefsToSet.set(key, val);
        }

        // Hack to avoid sending any request to pocket endpoints, should work
        // with feeds.section.topstories defaults to false
        this.onAddSection = this.onAddSection.bind(this);
        SectionsManager.on(SectionsManager.ADD_SECTION, this.onAddSection);

        // intentionally no break;
      default:
        break;
    }

    for (const key of prefsToSet.keys()) {
      this.setPref(key, prefsToSet.get(key));
    }
  },

  initRemotePages(reason = "init") {
    let branch = reason;
    let errMsg = "";
    try {
      errMsg = (
        (TelemetryTimestamps.get().delayedStartupFinished ? 1 : 0) +
        (Services.startup.getStartupInfo().sessionRestored ? 2 : 0)
      ).toString();
    } catch (ex) {
      errMsg = "-1";
      console.error(ex);
    }
    try {
      if (AboutNewTab.pageListener) {
        // After `AboutNewTab.init`
        let urls = AboutNewTab.pageListener.urls;
        if (!urls.includes(NEWTAB_URL)) {
          AboutNewTab.pageListener.destroy();
          AboutNewTab.pageListener = new remotePages(urls.concat([NEWTAB_URL]));
          branch = "pl_missing";
        } else {
          branch = "pl_existed";
        }
        // Before `AboutNewTab.activityStream.store._initIndexedDB` returns
      } else if (AboutNewTab.activityStream) {
        // After `AboutNewTab.onBrowserReady` @ `sessionstore-windows-restored`,
        // also after `AboutNewTab.activityStream.store._initIndexedDB` returns,
        // and `AboutNewTab.pageListener` become `null` again.
        let ASMessageChannel = AboutNewTab.activityStream.store._messageChannel;
        if (!ASMessageChannel.channel) {
          branch = "once_2722";
          console.error(`Should've been avoided, previously seen in bug 2722`);
        } else if (!ASMessageChannel.channel.urls.includes(NEWTAB_URL)) {
          // Hack to add another url w/o reinitialize this RemotePages channel
          ASMessageChannel.channel.urls.push(NEWTAB_URL);
          ASMessageChannel.channel.mococnPortCreated = remotePages.prototype.portCreated.bind(ASMessageChannel.channel);
          RemotePageManager.addRemotePageListener(NEWTAB_URL, ASMessageChannel.channel.mococnPortCreated);
          branch = "as_missing";
        } else {
          branch = "as_existed";
        }
      } else if (
        branch === "init" &&
        Services.vc.compare(Services.appinfo.version, "76.0") >= 0
      ) {
        // `AboutNewTab.init` was further delayed in https://bugzil.la/1619992
        branch = "will_retry";
        Services.obs.addObserver(this, "browser-delayed-startup-finished");
      } else {
        branch = "not_ready";
        console.error(`AboutNewTab.initialized is ${AboutNewTab.initialized}`);
      }
    } catch (ex) {
      branch = "error";
      errMsg = ex.toString();
      console.error(ex);
    }

    console.log("activityStreamHack.initRemotePages", reason, branch);
    ChinaNewtabFeed.sendTracking(
      "chinaNewtab",
      reason,
      "remotePages",
      branch,
      errMsg
    );
  },

  observe(subject, topic, data) {
    switch (topic) {
      case "browser-delayed-startup-finished":
        Services.obs.removeObserver(this, topic);
        Services.tm.dispatchToMainThread(() => {
          this.initRemotePages("retry");
        });
        break;
      case "newtab-url-changed":
        this.overrideNewtab(data);
        break;
      default:
        break;
    }
  },

  onAddSection(event, id, options) {
    if (event !== SectionsManager.ADD_SECTION || id !== "topstories") {
      return;
    }
    if (!options.options || !options.options.stories_endpoint.startsWith("https://api2.firefoxchina.cn/")) {
      return;
    }

    Services.prefs.setBoolPref("browser.newtabpage.activity-stream.feeds.section.topstories", true);
    SectionsManager.off(event, this.onAddSection);
  },

  overrideNewtab(newTabURL) {
    if (newTabURL !== this.newTabURL) {
      return;
    }

    // Since Fx 76, see https://bugzil.la/1619992
    if (AboutNewTab.hasOwnProperty("newTabURL")) {
      AboutNewTab.newTabURL = NEWTAB_URL;
    } else {
      aboutNewTabService.newTabURL = NEWTAB_URL;
    }
    // See https://bugzil.la/1184701,1625609
    Services.prefs.getDefaultBranch("browser.tabs.remote.").setBoolPref("separatePrivilegedContentProcess", false);
  },

  setPref(key, val) {
    if (Services.prefs.prefIsLocked(key)) {
      Services.prefs.unlockPref(key);
    }

    switch (typeof val) {
      case "boolean":
        Services.prefs.setBoolPref(key, val);
        break;
      case "number":
        Services.prefs.setIntPref(key, val);
        break;
      case "string":
        Services.prefs.setStringPref(key, val);
        break;
    }
  },

  uninit() {
    Services.obs.removeObserver(this, "newtab-url-changed");

    // Shouldn't be necessary, but in case?
    try {
      Services.obs.removeObserver(this, "browser-delayed-startup-finished");
    } catch (ex) {}
  },
};

this.chinaNewtabFeed = {
  initialized: false,

  init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    if (AboutNewTab.activityStream) {
      let store = AboutNewTab.activityStream.store;

      store._feedFactories.set("feeds.chinanewtab", () => new ChinaNewtabFeed());
      store.initFeed("feeds.chinanewtab", store._initAction);
    } else {
      console.error(`AboutNewTab not initialized?`);
    }
  },
};

this.contentSearch = {
  init(extension) {
    try {
      let needsCompatChild = extension.startupReason === "ADDON_UPGRADE" &&
                             extension.addonData.oldVersion === "4.77";

      ChromeUtils.registerWindowActor("ChinaNewtabContentSearch", {
        parent: {
          moduleURI: `resource://${RESOURCE_HOST}/ChinaNewtabContentSearchParent.jsm`,
        },
        child: {
          moduleURI: (needsCompatChild
            ? `resource://${RESOURCE_HOST}/ChinaNewtabContentSearchChildCompat.jsm`
            : `resource://${RESOURCE_HOST}/ChinaNewtabContentSearchChild.jsm`),
          events: {
            ContentSearchClient: { capture: true, wantUntrusted: true },
          },
        },
        matches: [
          "https://newtab.firefoxchina.cn/*",
        ],
      });
    } catch (ex) {
      console.error(ex);
    }
  },

  uninit() {
    ChromeUtils.unregisterWindowActor("ChinaNewtabContentSearch");
  },
};

this.ntpColors = {
  init() {
    try {
      ChromeUtils.registerWindowActor("ChinaNewtabContentTheme", {
        // `parent` required before Fx 69, see https://bugzil.la/1552268
        parent: {
          moduleURI: `resource://${RESOURCE_HOST}/ChinaNewtabContentThemeParent.jsm`,
        },
        child: {
          moduleURI: `resource://${RESOURCE_HOST}/ChinaNewtabContentThemeChild.jsm`,
          events: {
            pageshow: { mozSystemGroup: true },
          },
        },
        matches: [
          "https://newtab.firefoxchina.cn/*",
        ],
      });
    } catch (ex) {
      console.error(ex);
    }
  },

  uninit() {
    ChromeUtils.unregisterWindowActor("ChinaNewtabContentTheme");
  },
};

this.remotePages = class extends RemotePages {
  portCreated(port) {
    if (port.url === NEWTAB_URL) {
      chinaNewtabFeed.init();
    }

    // Previously also used to hack the url reported to telemetry
    // by modifying `target` of the "RemotePage:Init" message.
    return super.portCreated(port);
  }
};

this.searchPlugins = {
  get searchTN() {
    let searchTN = "error";
    try {
      let engine = Services.search.getEngineByName("\u767e\u5ea6");
      let newtabUrl = engine.getSubmission("TEST", null, "newtab").uri.spec;
      searchTN = (new URL(newtabUrl)).searchParams.get("tn") || "notset";
    } catch (ex) {
      Cu.reportError(ex);
      return searchTN;
    }
    delete this.searchTN;
    return this.searchTN = searchTN;
  },

  async init() {
    await Services.search.init();

    if (this.searchTN !== "monline_4_dg") {
      return;
    }

    this.overrideSearchEngine();
  },

  overrideSearchEngine() {
    let engine = Services.search.getEngineByName("\u767e\u5ea6");
    if (!engine) {
      return;
    }

    let shortName = "baidu-mozParamCN";
    engine = engine.wrappedJSObject;
    for (let url of engine._urls) {
      if (url.type !== "text/html") {
        continue;
      }

      url.params = url.params.filter(param => param.name !== "tn");
      url.addParam("tn", "monline_4_dg", "searchbar");
      url.addParam("tn", "monline_3_dg", "homepage");
      url.addParam("tn", "monline_3_dg", "newtab");
    }
    engine._shortName = shortName;
  },
};

this.topSites = {
  attachmentBase: "https://offlintab.firefoxchina.cn",
  backfillPrefixes: {
    "0ef7766c": [3],
    "0ff1094d": [4],
    "1490769a": [5],
    "1beb4001": [4],
    "2b616a4a": [4],
    "313e9486": [2],
    "381d5ce9": [4],
    "39975ae4": [6],
    "3df5e780": [0],
    "3e33a886": [4],
    "3e4d4729": [4],
    "468f82e6": [3],
    "4ca16353": [4],
    "4dd1c540": [3],
    "6fd68a18": [4],
    "78396aeb": [7],
    "7ee9a10c": [5],
    "83469c68": [5],
    "8e094349": [4],
    "96bc9794": [4],
    "9f4632fb": [6, 7],
    "a9ab9324": [4],
    "adce6b03": [1],
    "b18eca4f": [4],
    "bc4ba8bf": [6],
    "ca31f5d3": [4],
    "f0ff22c0": [5, 6],
    "f243aa87": [4],
    "f3726955": [4],
    "ff2bdf2c": [5],
  },
  prefKey: "browser.newtabpage.pinned",

  get feed() {
    try {
      let feed = AboutNewTab.activityStream.store.feeds.get("feeds.topsites");

      delete this.feed;
      return this.feed = feed;
    } catch (ex) {
      console.error(ex);
      return null;
    }
  },

  async cacheExtraScreenshot(index) {
    if (!this.feed) {
      return;
    }

    let links = await this.feed.pinnedCache.request();
    let link = links[index];
    if (!link) {
      return;
    }

    await this.feed._fetchScreenshot(link, link.url);
  },

  convertSite(site) {
    let customScreenshotURL = site.attachment &&
      site.attachment.location &&
      site.id &&
      `${this.attachmentBase}${site.attachment.location}?mococn_dp=${site.id}`;

    return {
      customScreenshotURL,
      label: site.label,
      url: site.url,
    };
  },

  getCurrentMaps(data) {
    let currentById = new Map();
    let idByUrl = new Map();

    for (let currentSite of data.current) {
      let site = this.convertSite(currentSite);
      if (!site.customScreenshotURL) {
        continue;
      }

      currentById.set(currentSite.id, site);
      idByUrl.set(currentSite.url, currentSite.id);
    }

    return {currentById, idByUrl};
  },

  getDefaultPosition(site) {
    try {
      return (new URL(site.customScreenshotURL)).searchParams.get("mococn_dp");
    } catch (ex) {
      return null;
    }
  },

  guessDefaultPosition(site) {
    let commonPrefix = `${this.attachmentBase}/data/thumbnails/`;
    if (!site.customScreenshotURL.startsWith(commonPrefix)) {
      return {prefix: "(notset)"};
    }

    let prefix = site.customScreenshotURL.substr(commonPrefix.length, 8);
    return {positions: this.backfillPrefixes[prefix], prefix};
  },

  async handleBackfill(data) {
    let backfillData = undefined;
    let {currentById: missingById, idByUrl} = this.getCurrentMaps(data);
    let guessByUrl = new Map();

    let cachedSites = await this.feed.pinnedCache.request();
    for (let [index, cachedSite] of cachedSites.entries()) {
      if (!cachedSite ||
          !cachedSite.customScreenshotURL ||
          !cachedSite.customScreenshotURL.startsWith(this.attachmentBase)) {
        continue;
      }

      let defaultPosition = this.getDefaultPosition(cachedSite);
      if (defaultPosition) {
        missingById.delete(defaultPosition);
        continue;
      }

      let siteId = idByUrl.get(cachedSite.url);
      let site = missingById.get(siteId);
      if (siteId && site) {
        missingById.delete(siteId);
        // Only backfill one site at a time
        backfillData = backfillData || {index, site};
        continue;
      }

      let guess = this.guessDefaultPosition(cachedSite);
      guessByUrl.set(cachedSite.url, guess.positions);
      if (guess.positions) {
        continue;
      }

      this.sendTracking("backfill", "unknownPrefix", `${guess.prefix}`);
    }

    if ((
      guessByUrl.size &&
      (await this.maybeFakeUpdate(data, guessByUrl, missingById))
    ) || !backfillData) {
      return;
    }

    await this.feed.pin({data: backfillData});
    this.sendTracking("backfill", "defaultPosition", `${backfillData.index}`);
  },

  async handleCreated(data) {
    let pinned = [];
    for (let currentSite of data.current) {
      let site = this.convertSite(currentSite);
      if (!site.customScreenshotURL) {
        continue;
      }

      pinned[parseInt(currentSite.id, 10)] = site;
    }
    Services.prefs.setStringPref(this.prefKey, JSON.stringify(pinned));

    // Multiple levels of caches to expire/reset ...
    NewTabUtils.pinnedLinks.resetCache();
    if (!this.feed) {
      return;
    }
    this.feed.pinnedCache.expire();
    this.feed.refresh({broadcast: true});
  },

  async handleEvent(evt) {
    if (!evt || !evt.data) {
      return;
    }

    // This should work for fresh profiles
    if (Services.prefs.prefHasUserValue(this.prefKey) &&
        Services.prefs.getStringPref(this.prefKey) !== "[]") {
      await this.handleUpdated(evt.data);
    } else {
      await this.handleCreated(evt.data);
    }
  },

  async handleUpdated(data) {
    if (!data.updated.length) {
      await this.handleBackfill(data);
      return;
    }

    let {currentById, idByUrl} = this.getCurrentMaps(data);
    let updatedIdByUrl = new Map();
    for (let {old: oldSite, new: newSite} of data.updated) {
      updatedIdByUrl.set(oldSite.url, newSite.id);
    }

    let counts = {
      usredit: 0,
      updated: 0,
      nomatch: 0,
      current: 0,
      bug2714: 0,
    };
    let ctrlPrefKey = `services.sync.prefs.sync.${this.prefKey}`;
    let ctrlPrefVal = Services.prefs.getBoolPref(ctrlPrefKey, true);
    try {
      Services.prefs.setBoolPref(ctrlPrefKey, false);
      let cachedSites = await this.feed.pinnedCache.request();
      await Promise.all(cachedSites.map(async (cachedSite, index) => {
        try {
          if (!cachedSite ||
              !cachedSite.customScreenshotURL ||
              !cachedSite.customScreenshotURL.startsWith(this.attachmentBase)) {
            counts.usredit += 1;
            return;
          }

          if (cachedSite.customScreenshotURL === "https://offlintab.firefoxchina.cnundefined") {
            await this.feed.pin({data: {
              index,
              site: {
                customScreenshotURL: null,
                label: cachedSite.label,
                url: cachedSite.url,
              },
            }});
            counts.bug2714 += 1;
            return;
          }

          let site = currentById.get(
            this.getDefaultPosition(cachedSite) ||
            updatedIdByUrl.get(cachedSite.url) ||
            idByUrl.get(cachedSite.url)
          );
          if (site) {
            if (
              !site.customScreenshotURL.startsWith(cachedSite.customScreenshotURL) ||
              site.label !== cachedSite.label ||
              site.url !== cachedSite.url
            ) {
              console.log(`${cachedSite.url} => ${site.url}`);
              await this.feed.pin({data: {index, site}});
              counts.updated += 1;
            } else {
              counts.current += 1;
            }
          } else {
            counts.nomatch += 1;
          }
        } catch (ex) {
          console.error(ex);
        }
      }));
    } catch (ex) {
      console.error(ex);
    } finally {
      Services.prefs.setBoolPref(ctrlPrefKey, ctrlPrefVal);

      this.sendTracking(
        "update",
        `${counts.usredit}|${counts.updated}|${counts.nomatch}|${counts.current}|${counts.bug2714}`
      );
    }
  },

  async maybeFakeUpdate(data, guessByUrl, missingById) {
    let counts = {
      ambiguous: 0,
      conflict: 0,
      matched: 0,
      noidea: 0,
    };
    let guessedPositionCount = new Map();
    let status = data.current.map(currentSite => {
      return missingById.has(currentSite.id) ? 0 : "-";
    });
    status.push("|");
    status.push(0);

    for (let guessedPositions of guessByUrl.values()) {
      if (!guessedPositions || guessedPositions.length < 1) {
        counts.noidea += 1;
        status[status.length - 1] += 1;
        continue;
      }

      for (let guessedPosition of guessedPositions) {
        if (isNaN(status[guessedPosition])) {
          status[guessedPositions] = "*";
        } else {
          status[guessedPositions] += 1;
          status[guessedPositions] = Math.min(status[guessedPositions], 9);
        }
      }

      if (guessedPositions.length > 1) {
        counts.ambiguous += 1;
        continue;
      }
      let guessedPosition = `${guessedPositions[0]}`;

      if (!missingById.has(guessedPosition)) {
        counts.conflict += 1;
        continue;
      }

      counts.matched += 1;
      guessedPositionCount.set(
        guessedPosition,
        (guessedPositionCount.get(guessedPosition) || 0) + 1
      );
    }

    console.log({ counts, guessedPositionCount, status });
    this.sendTracking("backfill", "status", status.join(""));
    if (counts.ambiguous || counts.conflict || counts.noidea) {
      this.sendTracking(
        "backfill",
        "blocked",
        `${counts.ambiguous}|${counts.conflict}|${counts.matched}|${counts.noidea}`
      );
      return false;
    }

    let duplicatedId = [];
    for (let [guessedPosition, count] of guessedPositionCount.entries()) {
      if (count > 1) {
        duplicatedId.push(guessedPosition);
      }
    }
    if (duplicatedId.length) {
      this.sendTracking("backfill", "duplicated", duplicatedId.join("|"));
      return false;
    }

    // Fake an update from cached url to guessed url
    for (let [url, guessedPositions] of guessByUrl.entries()) {
      data.updated.push({
        "old": {url},
        "new": {id: `${guessedPositions[0]}`},
      });
    }
    // Nothing to update, and nobody want no OOM from an infinite loop
    if (!data.updated.length) {
      return false;
    }

    console.log(data);
    await this.handleUpdated(data);
    this.sendTracking("backfill", "handled", `${data.updated.length}`);
    return true;
  },

  async sendTracking(method, value, extra = "") {
    return ChinaNewtabFeed.sendTracking(
      "chinaNewtab",
      method,
      "topSites",
      value,
      extra
    );
  },
};

this.chinaNewtab = class extends ExtensionAPI {
  onStartup() {
    let {extension} = this;

    this.flushCacheOnUpgrade(extension);
    resProto.setSubstitution(RESOURCE_HOST,
      Services.io.newURI("legacy/", null, extension.rootURI));

    activityStreamHack.init(extension);

    contentSearch.init(extension);
    ntpColors.init();
    searchPlugins.init();
  }

  onShutdown() {
    ntpColors.uninit();
    contentSearch.uninit();

    activityStreamHack.uninit();

    resProto.setSubstitution(RESOURCE_HOST, null);
  }

  flushCacheOnUpgrade(extension) {
    if (extension.startupReason !== "ADDON_UPGRADE") {
      return;
    }

    // Taken from https://bugzil.la/1445739
    Services.obs.notifyObservers(null, "startupcache-invalidate");
    Services.obs.notifyObservers(null, "message-manager-flush-caches");
    Services.mm.broadcastAsyncMessage("AddonMessageManagerCachesFlush", null);
  }

  getAPI(context) {
    return {
      mozillaonline: {
        chinaNewtab: {
          async updateTopSites(event) {
            return topSites.handleEvent(event);
          },
        },
      },
    };
  }
};
