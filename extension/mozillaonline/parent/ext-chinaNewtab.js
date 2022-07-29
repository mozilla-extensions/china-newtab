/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const NEWTAB_URL = "https://newtab.firefoxchina.cn/newtab/as/activity-stream.html";
const RESOURCE_HOST = "china-newtab";

/* global ExtensionAPI, Services, XPCOMUtils */
XPCOMUtils.defineLazyModuleGetters(this, {
  AboutNewTab: "resource:///modules/AboutNewTab.jsm",
  ChinaNewtabFeed: `resource://${RESOURCE_HOST}/ChinaNewtabFeed.jsm`,
  NewTabUtils: "resource://gre/modules/NewTabUtils.jsm",
  RemotePageManager: "resource://gre/modules/remotepagemanager/RemotePageManagerParent.jsm",
  RemotePages: "resource://gre/modules/remotepagemanager/RemotePageManagerParent.jsm",
  SectionsManager: "resource://activity-stream/lib/SectionsManager.jsm",
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
  extensionId: null,
  mutationObserverOptions: {
    childList: true,
  },
  newTabURL: null,

  init(extension) {
    this.extensionId = extension.id;
    this.newTabURL = extension.baseURI.resolve("newtab/newtab.html");

    this.initNewTabOverride();
    this.initPrefs();
    this.initRemotePages();
  },

  initMutationObserver(prefWin) {
    let menupopup = prefWin.document.getElementById("newTabMode").menupopup;
    if (menupopup.getElementsByAttribute("value", this.extensionId).length) {
      return;
    }

    let mutationObserver = new prefWin.MutationObserver(this.mutationCallback.bind(this));
    mutationObserver.observe(menupopup, this.mutationObserverOptions);
  },

  initNewTabOverride() {
    this.overrideNewtab(AboutNewTab.newTabURL);
    Services.obs.addObserver(this, "newtab-url-changed");
    Services.obs.addObserver(this, "home-pane-loaded");
  },

  initPrefs() {
    // Store some of the prefs in a WebExtension aware way so they're reverted on disable/uninstall?
    let currentVersion = Services.prefs.getIntPref("extensions.chinaNewtab.prefVersion", 0);
    let prefsToSet = new Map();
    switch (currentVersion) {
      case 0:
        for (let [key, val] of [
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
          // Disable appcache based offlintab from cehomepage
          ["moa.ntab.openInNewTab", false],
        ]) {
          prefsToSet.set(key, val);
        }

        // Hack to avoid sending any request to pocket endpoints, should work
        // with `feeds.system.topstories` defaults to `false`
        this.onAddSection = this.onAddSection.bind(this);
        SectionsManager.on(SectionsManager.ADD_SECTION, this.onAddSection);

        // intentionally no break;
      case 1:
        // If `currentVersion` is `0`, this pref should be set in
        // `this.onAddSection` instead of here
        if (currentVersion === 1) {
          prefsToSet.set("browser.newtabpage.activity-stream.feeds.system.topstories", true);
        }

        // intentionally no break;
      case 2:
        // Flip on DiscoveryStream
        for (let [key, val] of [
          ["browser.newtabpage.activity-stream.discoverystream.config", JSON.stringify({
            "collapsible": true,
            "enabled": true,
            "show_spocs": false,
            "hardcoded_layout": false,
            "personalized": false,
            "layout_endpoint": "https://newtab.firefoxchina.cn/newtab/ds/china-basic.json",
          })],
          ["browser.newtabpage.activity-stream.discoverystream.enabled", true],
          ["extensions.chinaNewtab.prefVersion", 3],
        ]) {
          prefsToSet.set(key, val);
        }
        break;
      default:
        break;
    }

    for (const [key, val] of prefsToSet) {
      this.setPref(key, val);
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
      } else if (branch === "init") {
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

  mutationCallback(records, observer) {
    for (let record of records) {
      if (record.type !== "childList") {
        continue;
      }

      for (let addedNode of record.addedNodes) {
        if (addedNode.value !== this.extensionId) {
          continue;
        }

        let menulist = record.target.parentNode;
        if (
          menulist.getAttribute("value") === this.extensionId &&
          !menulist.selectedItem
        ) {
          menulist.removeAttribute("value");
        }

        let prefWin = record.target.ownerGlobal;
        if (prefWin.gHomePane && prefWin.gHomePane.syncFromNewTabPref) {
          prefWin.gHomePane.syncFromNewTabPref();
        }

        observer.disconnect();
        break;
      }
    }
  },

  observe(subject, topic, data) {
    switch (topic) {
      case "browser-delayed-startup-finished":
        Services.obs.removeObserver(this, topic);
        Services.tm.dispatchToMainThread(() => {
          this.initRemotePages("retry");
        });
        break;
      case "home-pane-loaded":
        this.initMutationObserver(subject);
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

    let prefKey = "browser.newtabpage.activity-stream.feeds.system.topstories";
    Services.prefs.setBoolPref(prefKey, true);
    SectionsManager.off(event, this.onAddSection);
  },

  overrideNewtab(newTabURL) {
    if (newTabURL !== this.newTabURL) {
      return;
    }

    AboutNewTab.newTabURL = NEWTAB_URL;
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

this.asRouter = {
  init() {
    try {
      ChromeUtils.registerWindowActor("ChinaNewtabASRouter", {
        parent: {
          moduleURI: `resource://${RESOURCE_HOST}/ChinaNewtabASRouterParent.jsm`,
        },
        child: {
          moduleURI: `resource://${RESOURCE_HOST}/ChinaNewtabASRouterChild.jsm`,
          events: {
            DOMWindowCreated: {},
          },
        },
        matches:  [
          "https://newtab.firefoxchina.cn/*",
        ],
      });
    } catch (ex) {
      console.error(ex);
    }
  },

  uninit() {
    ChromeUtils.unregisterWindowActor("ChinaNewtabASRouter");
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
  init() {
    try {
      ChromeUtils.registerWindowActor("ChinaNewtabContentSearch", {
        parent: {
          moduleURI: `resource://${RESOURCE_HOST}/ChinaNewtabContentSearchParent.jsm`,
        },
        child: {
          moduleURI: `resource://${RESOURCE_HOST}/ChinaNewtabContentSearchChild.jsm`,
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
    "046255d2": [4, 3], // as-icons
    "05d144db": [6],
    "0ef7766c": [3],
    "0ff1094d": [4],
    "1490769a": [5],
    "1beb4001": [4],
    "1e88a405": [5], // as-icons
    "237d73b2": [7],
    "2b616a4a": [4],
    "313a1105": [4], // as-icons
    "313e9486": [2],
    "381d5ce9": [4],
    "39975ae4": [6],
    "3df5e780": [0],
    "3e33a886": [4],
    "3e4d4729": [4],
    "440e2d7c": [4],
    "468f82e6": [3],
    "491725fc": [5], // as-icons
    "4a112aca": [7], // as-icons
    "4ca16353": [4],
    "4dd1c540": [3],
    "6b203324": [6],
    "6fd68a18": [4],
    "70199cba": [4, 6, 7, 5],
    "71ecd4fd": [1, 2],
    "78396aeb": [7],
    "7c2b3ec9": [3, 2], // as-icons
    "7eb6052d": [5],
    "7ee9a10c": [5],
    "83469c68": [5],
    "8e094349": [4],
    "903b39f8": [3],
    "910f7dca": [2], // as-icons
    "9355218c": [5],
    "96bc9794": [4],
    "9f4632fb": [6, 7],
    "a9ab9324": [4],
    "a4f13a05": [6], // as-icons
    "adce6b03": [1],
    "b18eca4f": [4],
    "bc4ba8bf": [6],
    "ca31f5d3": [4],
    "e78f8151": [1], // as-icons
    "e6f12b12": [4],
    "ef925e06": [0],
    "f0ff22c0": [5, 6],
    "f243aa87": [4],
    "f3726955": [4],
    "ff2bdf2c": [5],
  },
  prefKey: "browser.newtabpage.pinned",

  get feed() {
    try {
      let feed = AboutNewTab.activityStream.store.feeds.get("feeds.system.topsites");

      delete this.feed;
      return this.feed = feed;
    } catch (ex) {
      console.error(ex);
      return null;
    }
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
    if (site.customScreenshotURL.startsWith(commonPrefix)) {
      let prefix = site.customScreenshotURL.substr(commonPrefix.length, 8);
      return {positions: this.backfillPrefixes[prefix], prefix};
    }

    let distPrefix = `${this.attachmentBase}/static/img/as-icons/`;
    if (site.customScreenshotURL.startsWith(distPrefix)) {
      let prefix = site.customScreenshotURL.substr(distPrefix.length, 8);
      return {positions: this.backfillPrefixes[prefix], prefix};
    }

    return {prefix: "(notset)"};
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
      ambiguous: new Set(),
      conflict: new Set(),
      matched: new Map(),
      noidea: new Set(),
    };
    let status = data.current.map(currentSite => {
      return missingById.has(currentSite.id) ? 0 : "-";
    });

    for (let [url, guessedPositions] of guessByUrl.entries()) {
      if (!guessedPositions || guessedPositions.length < 1) {
        counts.noidea.add(url);
        continue;
      }

      if (guessedPositions.length > 1) {
        counts.ambiguous.add(url);
        continue;
      }
      let guessedPosition = guessedPositions[0];

      if (isNaN(status[guessedPosition])) {
        status[guessedPosition] = "*";
      } else {
        status[guessedPosition] += 1;
        status[guessedPosition] = Math.min(status[guessedPosition], 9);
      }

      if (!missingById.has(`${guessedPosition}`)) {
        counts.conflict.add(url);
        continue;
      }

      counts.matched.set(
        guessedPosition,
        (counts.matched.get(guessedPosition) || 0) + 1
      );
    }

    if (
      counts.ambiguous.size + counts.conflict.size + counts.noidea.size === 1 &&
      counts.matched.size + 1 === missingById.size &&
      status.filter(item => item === 0).length === 1
    ) {
      let altPosition = status.indexOf(0);
      let url = counts.ambiguous.keys().next().value ||
                counts.conflict.keys().next().value ||
                counts.noidea.keys().next().value;

      if (
        missingById.has(`${altPosition}`) &&
        !counts.matched.has(altPosition) &&
        guessByUrl.has(url)
      ) {
        guessByUrl.set(url, [altPosition]);
        this.sendTracking("backfill", "missing1", `${altPosition}`);
        return this.maybeFakeUpdate(data, guessByUrl, missingById);
      }
    }

    this.sendTracking("backfill", "status", [
      status.join(""),
      counts.noidea.size,
    ].join("|"));
    if (counts.ambiguous.size + counts.conflict.size + counts.noidea.size) {
      let matchedSum = Array.from(counts.matched.values()).reduce((x, y) => x + y, 0);

      this.sendTracking(
        "backfill",
        "blocked",
        `${counts.ambiguous.size}|${counts.conflict.size}|${matchedSum}|${counts.noidea.size}`
      );
      return false;
    }

    let duplicatedId = [];
    for (let [guessedPosition, count] of counts.matched.entries()) {
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

    asRouter.init();
    contentSearch.init();
    ntpColors.init();
    searchPlugins.init();
  }

  onShutdown() {
    ntpColors.uninit();
    contentSearch.uninit();
    asRouter.uninit();

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
