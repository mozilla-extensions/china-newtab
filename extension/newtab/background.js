/* vim: set ts=2 sw=2 sts=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

(async function() {
  const STORAGE_PREFIX = "topsites.pinned.default.";
  const TIMEOUT_INITIAL = 5e3;
  const TIMEOUT_REGULAR = 60e3 * 60 * 4;
  const TIMEOUT_RETRY = 60e3 * 5;
  let data;

  function convert(defaultDial) {
    let url = defaultDial.url;
    let label = defaultDial.title;
    let id = `${parseInt(defaultDial.defaultposition, 10) - 1}`;
    let attachment = {
      location: defaultDial.thumbnail,
    };
    return { attachment, id, label, url };
  }

  async function getLatestData() {
    try {
      let url = "https://offlintab.firefoxchina.cn/data/master-ii/defaultdials-0.json";
      let defaultDials = await (await fetch(url)).json();

      return Object.keys(defaultDials).map(index => {
        return convert(defaultDials[index]);
      });
    } catch (ex) {
      console.error(ex);
      return undefined;
    }
  }

  function isReallyUpdated({ old: oldValue, new: newValue = {}}) {
    // Should goes into `created`, which we don't really care, for now
    if (!oldValue) {
      return false;
    }

    if (oldValue.id === newValue.id &&
        oldValue.label === newValue.label &&
        oldValue.url === newValue.url &&
        (oldValue.attachment || {}).location ===
        (newValue.attachment || {}).location) {
      return false;
    }

    return true;
  }

  async function onStorageChange(changes, areaName) {
    if (areaName !== "local") {
      return;
    }

    data.updated = Object.keys(changes).filter(changedId => {
      return changedId.startsWith(STORAGE_PREFIX);
    }).map(changedId => {
      let change = changes[changedId];

      return {
        "old": change.oldValue,
        "new": change.newValue,
      };
    }).filter(isReallyUpdated);

    console.log(data);
    browser.mozillaonline.chinaNewtab.updateTopSites({ data });
  }

  async function update() {
    data = {
      current: (await getLatestData()),
    };
    if (!data.current) {
      setTimeout(update, TIMEOUT_RETRY);
      return;
    }

    let toSet = {};
    for (let currentSite of data.current) {
      toSet[`${STORAGE_PREFIX}${currentSite.id}`] = currentSite;
    }
    browser.storage.local.set(toSet);

    setTimeout(update, TIMEOUT_REGULAR);
  }

  browser.storage.onChanged.addListener(onStorageChange);
  setTimeout(update, TIMEOUT_INITIAL);
})();
