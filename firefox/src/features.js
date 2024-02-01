class Feature {
  constructor(config, configName) {
    this.config = config;
    this.configName = configName;
    this.started = false;
    config.onChange(configName, (v) => {
      v ? this.start() : this.stop();
    });
  }

  async maybeStart() {
    if (await this.config.get(this.configName)) {
      this.start();
    } else {
      this.stop();
    }
  }

  start() {
    this.started = true;
  }

  stop() {
    this.started = false;
  }
}

/* Burp Proxy */

function proxify(config, onlyContainers) {
  return async function (e) {
    if (onlyContainers && e.cookieStoreId == "firefox-default")
      return { type: "direct" };
    const host = await config.get("burpProxyHost");
    const port = await config.get("burpProxyPort");
    return {
      type: "http",
      host,
      port,
    };
  };
}

class UseBurpProxyAll extends Feature {
  constructor(config) {
    super(config, "useBurpProxyAll");
    this.proxy = proxify(config, false);
  }

  async start() {
    super.start();
    if (!(await this.config.get("enabled"))) return;

    browser.proxy.onRequest.addListener(this.proxy, { urls: ["<all_urls>"] });
  }

  stop() {
    browser.proxy.onRequest.removeListener(this.proxy);
    super.stop();
  }
}

class UseBurpProxyContainers extends Feature {
  constructor(config) {
    super(config, "useBurpProxyContainer");
    this.proxy = proxify(config, true);
  }

  async start() {
    super.start();
    if (!(await this.config.get("enabled"))) return;

    browser.proxy.onRequest.addListener(this.proxy, { urls: ["<all_urls>"] });
  }

  stop() {
    super.stop();
    browser.proxy.onRequest.removeListener(this.proxy);
  }
}

/* Add Color Headers */

const colorMap = {
  blue: "blue",
  turquoise: "cyan",
  green: "green",
  yellow: "yellow",
  orange: "orange",
  red: "red",
  pink: "pink",
  purple: "magenta",
};

async function colorQueryParameterHandler(e) {
  if (e.tabId < 0) return;

  const { cookieStoreId } = await browser.tabs.get(e.tabId);
  if (cookieStoreId === "firefox-default") {
    return {};
  }

  const identity = await browser.contextualIdentities.get(cookieStoreId);
  if (identity.name.startsWith("PwnFox-")) {
    const url = new URL(e.url);
    if (url.searchParams.has("_color")) {
      return {};
    }

    url.searchParams.set("_color", colorMap[identity.color]);
    return { redirectUrl: url.toString() };
  }

  return {};
}

async function colorTopLevelNavigation(e) {
    if (e.requestHeaders.find(({ name, value }) => name === "Sec-Fetch-Mode" && value === "navigate")) {
        const url = new URL(e.url);
        if (url.searchParams.has("_color")) {
            return {requestHeaders: e.requestHeaders};
        }

        url.searchParams.set("_color", "green");
        return { redirectUrl: url.toString(), requestHeaders: e.requestHeaders};
    }

    return {requestHeaders: e.requestHeaders};
}

class AddContainerHeader extends Feature {
  constructor(config) {
    super(config, "addContainerHeader");
  }

  async start() {
    super.start();
    if (!(await this.config.get("enabled"))) return;

    browser.webRequest.onBeforeRequest.addListener(
      colorQueryParameterHandler,
      { urls: ["<all_urls>"] },
      ["blocking"]
    );
  }

  stop() {
    browser.webRequest.onBeforeRequest.removeListener(
      colorQueryParameterHandler
    );
    super.stop();
  }
}

/* Remove security Headers */
function removeHeaders(response) {
  const { responseHeaders: origHeaders } = response;
  const blacklistedHeaders = [
    "Content-Security-Policy",
    "X-XSS-Protection",
    "X-Frame-Options",
    "X-Content-Type-Options",
  ];
  const newHeaders = origHeaders.filter(({ name }) => {
    return !blacklistedHeaders.includes(name);
  });
  return { responseHeaders: newHeaders };
}

class ColorizeTopLevelNavigation extends Feature {
  constructor(config) {
    super(config, "colorizeTopLevelNavigation");
  }

  async start() {
    super.start();
    if (!(await this.config.get("enabled"))) return;

    chrome.webRequest.onBeforeSendHeaders.addListener(
      colorTopLevelNavigation,
      { urls: ["<all_urls>"] },
      ["blocking", "requestHeaders"]
    );
  }

  stop() {
    browser.webRequest.onBeforeRequest.removeListener(colorTopLevelNavigation);
    super.stop();
  }
}

class RemoveSecurityHeaders extends Feature {
  constructor(config) {
    super(config, "removeSecurityHeaders");
  }

  async start() {
    super.start();
    if (!(await this.config.get("enabled"))) return;

    browser.webRequest.onHeadersReceived.addListener(
      removeHeaders,
      { urls: ["<all_urls>"] },
      ["blocking", "responseHeaders"]
    );
  }

  stop() {
    super.stop();
    browser.webRequest.onHeadersReceived.removeListener(removeHeaders);
  }
}

/* Toolbox */

class InjectToolBox extends Feature {
  constructor(config) {
    super(config, "injectToolbox");
    this.script = null;
    config.onChange("activeToolbox", () => this.maybeStart());
    config.onChange("savedToolbox", () => this.maybeStart());
  }

  async start() {
    super.start();
    if (!(await this.config.get("enabled"))) return;

    const toolboxName = await this.config.get("activeToolbox");
    const toolbox = (await this.config.get("savedToolbox"))[toolboxName] || "";

    if (this.script) {
      this.script.unregister();
    }

    this.script = await browser.contentScripts.register({
      allFrames: true,
      matches: ["<all_urls>"],
      runAt: "document_start",
      js: [
        {
          code: toolbox,
        },
      ],
    });
  }

  stop() {
    super.stop();
    if (this.script) {
      this.script.unregister();
    }
  }
}

/* Post Message */
function logMessage({ data, origin }) {
  browser.runtime.sendMessage({ data, origin, destination: window.origin });
}

class LogPostMessage extends Feature {
  constructor(config) {
    super(config, "logPostMessage");
  }

  async start() {
    super.start();
    if (!(await this.config.get("enabled"))) return;
    window.addEventListener("message", logMessage);
  }

  stop() {
    super.stop();
    window.removeEventListener("message", logMessage);
  }
}

/* Global Enable */

class FeaturesGroup extends Feature {
  constructor(config, features) {
    super(config, "enabled");
    this.features = features;
  }

  start() {
    super.start();
    this.features.forEach((f) => f.maybeStart());
  }

  stop() {
    super.stop();
    this.features.forEach((f) => f.stop());
  }
}

class BackgroundFeatures extends FeaturesGroup {
  constructor(config) {
    const features = [
      new UseBurpProxyContainers(config),
      new UseBurpProxyAll(config),
      new AddContainerHeader(config),
      new InjectToolBox(config),
      new RemoveSecurityHeaders(config),
      new ColorizeTopLevelNavigation(config),
    ];
    super(config, features);
  }

  start() {
    super.start();
    createIcon("#00ff00").then(([canvas, imageData]) => {
      browser.browserAction.setIcon({ imageData });
    });
  }

  stop() {
    super.stop();
    createIcon("#ff0000").then(([canvas, imageData]) => {
      browser.browserAction.setIcon({ imageData });
    });
  }
}

class ContentScriptFeatures extends FeaturesGroup {
  constructor(config) {
    const features = [new LogPostMessage(config)];
    super(config, features);
  }
}
