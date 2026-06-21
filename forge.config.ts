import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Include the data directory in the packaged app
    extraResource: ['./data'],
    name: 'L-Acoustic Amp Calc',
    osxSign: {
      // Pin the signing identity by SHA-1 fingerprint, not by name: the login keychain holds
      // multiple "Developer ID Application: John Somers (RY46BRL9M2)" certs, which makes the
      // name ambiguous (codesign then refuses and falls back to an adhoc signature, breaking
      // notarization). The fingerprint is unambiguous. (Clean up the duplicate certs to revert
      // to the portable name-based identity.)
      identity: 'DCA9DCBB5E6128BE7845A46DD4905630F292B8A4',
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: './entitlements.plist',
        'entitlements-inherit': './entitlements.plist',
        'signature-flags': 'library',
        timestamp: 'http://timestamp.apple.com/ts01',
      }),
    },
    osxNotarize: {
      keychainProfile: 'AC_PASSWORD',
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  publishers: [
    // `electron-forge publish` uploads the signed build to GitHub Releases.
    // Created as a draft — review it on GitHub, then click "Publish release" to make it
    // live (that's when update.electronjs.org serves it to clients). Set draft: false
    // to publish automatically.
    new PublisherGithub({
      repository: {
        owner: 'somersaudio',
        name: 'Unofficial-L-Acoustics-Calculator-Beta-0.9.1',
      },
      draft: true,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
