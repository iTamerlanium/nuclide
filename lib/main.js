'use babel';
/* @noflow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

/**
 *                  _  _ _  _ ____ _    _ ___  ____
 *                  |\ | |  | |    |    | |  \ |___
 *                  | \| |__| |___ |___ | |__/ |___
 * _  _ _  _ _ ____ _ ____ ___     ___  ____ ____ _  _ ____ ____ ____
 * |  | |\ | | |___ | |___ |  \    |__] |__| |    |_/  |__| | __ |___
 * |__| | \| | |    | |___ |__/    |    |  | |___ | \_ |  | |__] |___
 *
 */

import featureConfig from '../pkg/commons-atom/featureConfig';
import fs from 'fs';
import invariant from 'assert';
// eslint-disable-next-line nuclide-internal/prefer-nuclide-uri
import path from 'path';
import {setUseLocalRpc} from '../pkg/nuclide-remote-connection/lib/service-manager';
import electron from 'electron';
import {CompositeDisposable} from 'atom';
import {install as atomPackageDepsInstall} from 'atom-package-deps';
import nuclidePackageJson from '../package.json';
import configMigrator from './configMigrator';

const {remote} = electron;
invariant(remote != null);

// Add a dummy deserializer. This forces Atom to load Nuclide's main module
// (this file) when the package is loaded, which is super important because
// this module loads all of the Nuclide features. We could accomplish the same
// thing by unsetting [the local storage value][1] that Atom uses to indicate
// whether the main module load can be deferred, however, that would mean that
// (for a brief time, at least), the flag would be set. If there were an error
// during that time and we never got a chance to unset the flag, Nuclide
// features would never load again!
//
// [1] https://github.com/atom/atom/blob/v1.9.8/src/package.coffee#L442
atom.deserializers.add({
  name: 'nuclide.ForceMainModuleLoad',
  deserialize() {},
});

// Run settings migrations
configMigrator();

// Exported "config" object
export const config = {
  installRecommendedPackages: {
    default: false,
    description:
      'On start up, check for and install Atom packages recommended for use with Nuclide. The'
      + ' list of packages can be found in the <code>package-deps</code> setting in this package\'s'
      + ' "package.json" file. Disabling this setting will not uninstall packages it previously'
      + ' installed. Restart Atom after changing this setting for it to take effect.',
    title: 'Install Recommended Packages on Startup',
    type: 'boolean',
  },
  useLocalRpc: {
    default: false,
    description:
      'Use RPC marshalling for local services. This ensures better compatibility between the local'
      + ' and remote case. Useful for internal Nuclide development. Requires restart to take'
      + ' effect.',
    title: 'Use RPC for local Services.',
    type: 'boolean',
  },
  use: {
    type: 'object',
    properties: {},
  },
};

const runningNuclideVersion = nuclidePackageJson.version;

// Nuclide packages for Atom are called "features"
const FEATURES_DIR = path.join(__dirname, '../pkg');
const features = {};

let disposables;

/**
 * Get the "package.json" of all the features.
 */
fs.readdirSync(FEATURES_DIR).forEach(item => {
  // Optimization: Our directories don't have periods - this must be a file
  if (item.indexOf('.') !== -1) {
    return;
  }
  const dirname = path.join(FEATURES_DIR, item);
  const filename = path.join(dirname, 'package.json');
  try {
    const stat = fs.statSync(filename);
    invariant(stat.isFile());
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return;
    }
  }
  const src = fs.readFileSync(filename, 'utf8');
  // Optimization: Avoid JSON parsing if it can't reasonably be an Atom package
  if (src.indexOf('"Atom"') === -1) {
    return;
  }
  const pkg = JSON.parse(src);
  if (pkg.nuclide && pkg.nuclide.packageType === 'Atom') {
    invariant(pkg.name);
    features[pkg.name] = {
      pkg,
      dirname,
      useKeyPath: `nuclide.use.${pkg.name}`,
    };
  }
});

/**
 * Build the "config" object. This determines the config defaults and
 * it's what is shown by the Settings view. It includes:
 * (1) An entry to enable/disable each feature - called "nuclide.use.*".
 * (2) Each feature's merged config.
 *
 * https://atom.io/docs/api/latest/Config
 */
Object.keys(features).forEach(name => {
  const {pkg} = features[name];

  // Sample packages are disabled by default. They are meant for development
  // use only, and aren't included in Nuclide builds.
  const enabled = !name.startsWith('sample-');

  // Entry for enabling/disabling the feature
  const setting = {
    title: `Enable the "${name}" feature`,
    description: pkg.description || '',
    type: 'boolean',
    default: enabled,
  };
  if (pkg.providedServices) {
    const provides = Object.keys(pkg.providedServices).join(', ');
    setting.description += `<br/>**Provides:** _${provides}_`;
  }
  if (pkg.consumedServices) {
    const consumes = Object.keys(pkg.consumedServices).join(', ');
    setting.description += `<br/>**Consumes:** _${consumes}_`;
  }
  config.use.properties[name] = setting;

  // Merge in the feature's config
  const pkgConfig = pkg.nuclide.config;
  if (pkgConfig) {
    config[name] = {
      type: 'object',
      properties: {},
    };
    Object.keys(pkgConfig).forEach(key => {
      config[name].properties[key] = {
        ...pkgConfig[key],
        title: (pkgConfig[key].title || key),
      };
    });
  }
});

// Nesting loads within loads leads to reverse activation order- that is, if
// Nuclide loads feature packages, then the feature package activations will
// happen before Nuclide's. So we wait until Nuclide is done loading, but before
// it activates, to load the features.
let initialLoadDisposable = atom.packages.onDidLoadPackage(pack => {
  if (pack.name !== 'nuclide') { return; }

  // Config defaults are not merged with user defaults until activate. At this
  // point `atom.config.get` returns the user set value. If it's `undefined`,
  // then the user has not set it.

  // `setUseLocalRpc` can only be called once, so it's set here during load.
  const _useLocalRpc = atom.config.get('nuclide.useLocalRpc');
  const _shouldUseLocalRpc = typeof _useLocalRpc === 'undefined'
    ? config.useLocalRpc.default
    : _useLocalRpc;
  setUseLocalRpc(_shouldUseLocalRpc);

  // Load all the features. This needs to be done during Atom's load phase to
  // make sure that deserializers are registered, etc.
  // https://github.com/atom/atom/blob/v1.1.0/src/atom-environment.coffee#L625-L631
  // https://atom.io/docs/api/latest/PackageManager
  Object.keys(features).forEach(name => {
    const feature = features[name];
    const _enabled = atom.config.get(feature.useKeyPath);
    const _shouldEnable = typeof _enabled === 'undefined'
      ? config.use.properties[name].default
      : _enabled;
    if (_shouldEnable) {
      atom.packages.loadPackage(feature.dirname);
    }
  });

  initialLoadDisposable.dispose();
  initialLoadDisposable = null;
});

export function activate() {
  // This version mismatch happens during OSS updates. After updates, Nuclide is
  // still in the module cache - with all of its glorious state - which usually
  // results in a red box of some kind because the disk content doesn't match
  // the expectations of the code that is in memory.
  const nuclidePack = atom.packages.getLoadedPackage('nuclide');
  const installedPkg =
    JSON.parse(fs.readFileSync(path.join(nuclidePack.path, 'package.json')));
  const installedNuclideVersion = installedPkg.version;
  if (installedNuclideVersion !== runningNuclideVersion) {
    atom.notifications.addWarning(`Nuclide's version has changed from
      v${runningNuclideVersion} to v${installedNuclideVersion}.
      Reload Atom to use the new version.`,
      {
        buttons: [
          {
            className: 'icon icon-zap',
            onDidClick() { atom.reload(); },
            text: 'Reload Atom',
          },
        ],
        dismissable: true,
      },
    );
    return;
  }

  invariant(!disposables);
  disposables = new CompositeDisposable();

  // Add the "Nuclide" menu, if it's not there already.
  disposables.add(
    atom.menu.add([{
      label: 'Nuclide',
      submenu: [{
        label: `Version ${runningNuclideVersion}`,
        enabled: false,
      }],
    }]),
  );

  // Manually manipulate the menu template order.
  const insertIndex =
    atom.menu.template.findIndex(item => item.role === 'window' || item.role === 'help');
  if (insertIndex !== -1) {
    const nuclideIndex = atom.menu.template.findIndex(item => item.label === 'Nuclide');
    const menuItem = atom.menu.template.splice(nuclideIndex, 1)[0];
    const newIndex = insertIndex > nuclideIndex ? insertIndex - 1 : insertIndex;
    atom.menu.template.splice(newIndex, 0, menuItem);
    atom.menu.update();
  }

  // Activate all of the loaded features. Technically, this will be a no-op
  // generally because Atom [will activate all loaded packages][1]. However,
  // that won't happen, for example, with our `activateAllPackages()`
  // integration test helper.
  //
  // [1]: https://github.com/atom/atom/blob/v1.9.0/src/package-manager.coffee#L425
  Object.keys(features).forEach(name => {
    const feature = features[name];
    if (atom.config.get(feature.useKeyPath)) {
      atom.packages.activatePackage(feature.dirname);
    }
  });

  // Watch the config to manage toggling features
  Object.keys(features).forEach(name => {
    const feature = features[name];
    const watcher = atom.config.onDidChange(feature.useKeyPath, event => {
      if (event.newValue === true) {
        atom.packages.activatePackage(feature.dirname);
      } else if (event.newValue === false) {
        safeDeactivate(name);
      }
    });
    disposables.add(watcher);
  });

  // Install public, 3rd-party Atom packages listed in this package's 'package-deps' setting. Run
  // this *after* other packages are activated so they can modify this setting if desired before
  // installation is attempted.
  if (featureConfig.get('installRecommendedPackages')) {
    // Workaround for restoring multiple Atom windows. This prevents having all
    // the windows trying to install the deps at the same time - often clobbering
    // each other's install.
    const firstWindowId = remote.BrowserWindow.getAllWindows()[0].id;
    const currentWindowId = remote.getCurrentWindow().id;
    if (firstWindowId === currentWindowId) {
      atomPackageDepsInstall('nuclide');
    }
  }
}

export function deactivate() {
  Object.keys(features).forEach(name => {
    safeDeactivate(name);
  });
  if (disposables) {
    disposables.dispose();
    disposables = null;
  }
}

function safeDeactivate(name) {
  try {
    const pack = atom.packages.getActivePackage(name);
    if (pack != null) {
      // TODO: Atom does not unregister its activation hooks on package deactivation!
      // Do it manually until https://github.com/atom/atom/pull/12237 is merged.
      if (pack.activationHookSubscriptions != null) {
        pack.activationHookSubscriptions.dispose();
      }
      atom.packages.deactivatePackage(name);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Error deactivating "${name}": ${err.message}`);
  }
}
