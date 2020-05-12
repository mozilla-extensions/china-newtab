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
  callbacks: new WeakMap(),

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

  async handleCreated(data) {
    let pinned = [];
    for (let currentSite of data.current) {
      let customScreenshotURL = currentSite.attachment &&
        currentSite.attachment.location &&
        `${this.attachmentBase}${currentSite.attachment.location}`;
      if (!customScreenshotURL) {
        continue;
      }

      pinned[parseInt(currentSite.id, 10)] = {
        customScreenshotURL,
        label: currentSite.label,
        url: currentSite.url,
      };
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
      return;
    }

    let current = {};
    let updated = {};
    for (let currentSite of data.current) {
      let customScreenshotURL = currentSite.attachment &&
        currentSite.attachment.location &&
        `${this.attachmentBase}${currentSite.attachment.location}`;
      if (!customScreenshotURL) {
        continue;
      }

      current[currentSite.url] = {
        customScreenshotURL,
        label: currentSite.label,
        url: currentSite.url,
      };
    }
    for (let {old: oldSite, new: newSite} of data.updated) {
      updated[oldSite.url] = newSite.url;
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
          if (!cachedSite.customScreenshotURL ||
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

          let site = current[updated[cachedSite.url] || cachedSite.url];
          if (site) {
            if (
              site.customScreenshotURL !== cachedSite.customScreenshotURL ||
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

      ChinaNewtabFeed.sendTracking(
        "chinaNewtab",
        "update",
        "topSites",
        `${counts.usredit}|${counts.updated}|${counts.nomatch}|${counts.current}|${counts.bug2714}`
      );
    }
  },
};

this.chinaNewtab = class extends ExtensionAPI {
  onStartup() {
    let {extension} = this;

    this.flushCacheOnUpgrade(extension);
    resProto.setSubstitution(RESOURCE_HOST,
      Services.io.newURI("legacy/", null, extension.rootURI));

    activityStreamHack.init(extension);

    contentSearch.init();
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
