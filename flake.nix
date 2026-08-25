{
  description = "AntSeed development environment and CLI package";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pnpm2nix = {
      url = "github:FliegendeWurst/pnpm2nix-nzbr";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, pnpm2nix }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;

      # Prebuilt native binaries fetched by prebuild-install at package build
      # time (the pnpm sandbox has no network, so they are pinned here).
      # Versions must stay in sync with pnpm-lock.yaml.
      prebuildInfo = {
        better-sqlite3 = {
          version = "12.6.2";
          abi = "node-v127"; # nodejs_22
          repo = "WiseLibs/better-sqlite3";
          napi = false;
          hashes = {
            x86_64-linux = "sha256-gpYGV8t3WNh4fNeoZgA8FwBcVCWZhuSBFuPA7GIZFTk=";
            aarch64-linux = "sha256-4Yqhr7C3fshNYMSiaLOm6HEjvVxhS1fDrcwHHrKXa/A=";
            x86_64-darwin = "sha256-0VwdLLHICREmMwUzDuVgcUHCQLjn134AJPp4GmVpWlI=";
            aarch64-darwin = "sha256-1NbsR6ZuSqYop00uCT3EBsTxibFbJDB0sz4CusX7JE8=";
          };
        };
        node-datachannel = {
          version = "0.7.0";
          abi = "napi-v8";
          repo = "murat-dogan/node-datachannel";
          napi = true;
          hashes = {
            x86_64-linux = "sha256-Ua6kZdUJMi+39hw7teHCbZbiTXoqk85pYp3Y+PKlJGw=";
            aarch64-linux = "sha256-Slpx9pTjMc1Bkv5JiDPoQDfFTURK1jxBDjkuo8afAbw=";
            x86_64-darwin = "sha256-aTeyR9F9c0ogujPGPtET7gWTK30MGO4jpYB1LpWCoPw=";
            aarch64-darwin = "sha256-Kd7nVMz2tqymCAFc5HsxvQK4BBK/X401VtNj99tan0c=";
          };
        };
        keytar = {
          version = "7.9.0";
          abi = "napi-v3";
          repo = "atom/node-keytar";
          napi = true;
          hashes = {
            x86_64-linux = "sha256-LXV1P6v53OtJU3riMeGJfeU3J7wPrbwqAeY3ShRDxnw=";
            aarch64-linux = "sha256-HFGsnSLKqIWwwvRhFvomqxfLEVlRJj2uo9YMRBelQ70=";
            x86_64-darwin = "sha256-TOVuOJbnai3q7xP4o2IH76bZTZZnjTAgCVLYPTJ+tfk=";
            aarch64-darwin = "sha256-GV8IVeJvg+DWHiKNG2HHdpuqmTJEUY3Jh52dVxBMfOw=";
          };
        };
      };

      platformInfo = {
        x86_64-linux = { os = "linux"; cpu = "x64"; };
        aarch64-linux = { os = "linux"; cpu = "arm64"; };
        x86_64-darwin = { os = "darwin"; cpu = "x64"; };
        aarch64-darwin = { os = "darwin"; cpu = "arm64"; };
      };
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              cacert
              cmake
              git
              ninja
              nodejs_22
              pkg-config
              pnpm_9
              python311
            ] ++ lib.optionals stdenv.isLinux [
              libsecret
            ];

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              export npm_config_python="${pkgs.python311}/bin/python3"
            '';
          };
        });

      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ pnpm2nix.overlays.default ];
          };
          inherit (pkgs) lib stdenv;

          nodejs = pkgs.nodejs_22;

          platform = platformInfo.${system};

          prebuildTarballs = lib.mapAttrs (name: info:
            let
              file = "${name}-v${info.version}-${info.abi}-${platform.os}-${platform.cpu}.tar.gz";
            in
            pkgs.fetchurl {
              url = "https://github.com/${info.repo}/releases/download/v${info.version}/${file}";
              hash = info.hashes.${system};
            }
          ) prebuildInfo;

          # Modules the bundle needs at runtime that cannot be inlined:
          # the native packages above plus their pure-JS runtime deps.
          runtimeNodeModules = [
            "better-sqlite3"
            "bindings"
            "file-uri-to-path"
            "keytar"
            "koffi"
            "node-datachannel"
            "node-domexception"
          ];
        in
        {
          # Built with pnpm2nix (FliegendeWurst/pnpm2nix-nzbr): dependencies
          # are fetched per-package using the integrity hashes in
          # pnpm-lock.yaml, so there is no single pnpmDeps hash to keep in
          # sync when the lockfile changes.
          default = pkgs.mkPnpmPackage {
            pname = "antseed-cli";
            version = (lib.importJSON ./apps/cli/package.json).version;

            workspace = ./.;
            components = [ "apps/cli" ];
            nodejs = nodejs;
            # pnpm 9: the lockfile is v9.0 and package.json's "pnpm" field
            # (patchedDependencies) is only read by pnpm < 10.
            pnpm = pkgs.pnpm_9;

            # pnpm install runs with --ignore-scripts, so replicate the
            # install-time bits the build depends on before compiling.
            preBuild = ''
              # 1. packages/node postinstall: patch ethers type declarations.
              node packages/node/scripts/patch-ethers.js

              # 2. Native modules: unpack the pinned prebuilds exactly the way
              #    prebuild-install would (it checks ./prebuilds/<tarball>
              #    first). The workspace uses node-linker=hoisted, so packages
              #    are real directories directly under node_modules/.
              pi_bin="$(readlink -f node_modules/prebuild-install)/bin.js"

              install_prebuild() {
                local pkg="$1" tarball="$2" file="$3"; shift 3
                local dir
                dir="$(readlink -f "node_modules/$pkg")"
                if [ ! -d "$dir" ]; then
                  echo "error: package $pkg not found in node_modules" >&2
                  return 1
                fi
                echo "Installing prebuild for $pkg ($dir)"
                mkdir -p "$dir/prebuilds"
                cp "$tarball" "$dir/prebuilds/$file"
                (cd "$dir" && node "$pi_bin" "$@")
              }

              ${lib.concatStringsSep "\n" (lib.mapAttrsToList (name: info:
                let
                  file = "${name}-v${info.version}-${info.abi}-${platform.os}-${platform.cpu}.tar.gz";
                in
                "install_prebuild ${name} ${prebuildTarballs.${name}} ${file} ${lib.optionalString info.napi "-r napi"}"
              ) prebuildInfo)}

              # .bin wrapper scripts carry /usr/bin/env shebangs that don't
              # resolve inside the sandbox.
              patchShebangs node_modules
              find apps packages plugins -type d -name node_modules | while read -r d; do
                patchShebangs "$d"
              done
              for f in node_modules/@esbuild/*/bin/esbuild node_modules/*/node_modules/@esbuild/*/bin/esbuild; do
                [ -f "$f" ] && chmod +x "$f"
              done
            '';

            # Build the CLI's whole workspace subgraph, then bundle it into a
            # single ESM file; native modules stay external and are shipped
            # alongside (same as build:bundle). ESM output breaks CJS deps
            # that call require(); the banner shims it.
            scriptFull = ''
              pnpm --filter='@antseed/cli...' run build

              mkdir -p apps/cli/dist
              esbuild apps/cli/src/cli/index.ts \
                --bundle --platform=node --format=esm \
                --outfile=apps/cli/dist/bundle.mjs \
                --external:better-sqlite3 --external:node-datachannel \
                --external:koffi --external:keytar \
                '--banner:js=import { createRequire as __antseedCreateRequire } from "node:module"; var require = __antseedCreateRequire(import.meta.url);'
            '';

            # Only the bundle and the dashboard assets are packaged; the final
            # layout is assembled in postInstall.
            distDirs = [
              "apps/cli/dist"
              "apps/payments/dist/web"
            ];

            extraNativeBuildInputs = [
              pkgs.esbuild
              pkgs.makeWrapper
            ] ++ lib.optionals stdenv.isLinux [
              pkgs.autoPatchelfHook
            ];

            # Shared libraries for the prebuilt native binaries (Linux).
            extraBuildInputs = lib.optionals stdenv.isLinux [
              pkgs.glib
              pkgs.libsecret
              stdenv.cc.cc.lib
            ];

            postInstall = ''
              mkdir -p "$out/libexec/antseed/node_modules" "$out/bin"

              mv "$out/apps/cli/dist/bundle.mjs" "$out/libexec/antseed/"
              # Web dashboard assets; @antseed/payments resolves ./web relative
              # to import.meta.url, which is the bundle's directory once built.
              mv "$out/apps/payments/dist/web" "$out/libexec/antseed/web"
              rm -rf "$out/apps"

              for pkg in ${lib.concatStringsSep " " runtimeNodeModules}; do
                if [ -e "node_modules/$pkg" ]; then
                  cp -rL "node_modules/$pkg" "$out/libexec/antseed/node_modules/$pkg"
                fi
              done

              # koffi's npm package ships binaries for every platform; keep
              # only the target one so autoPatchelf does not trip on the rest.
              if [ -d "$out/libexec/antseed/node_modules/koffi/build/koffi" ]; then
                find "$out/libexec/antseed/node_modules/koffi/build/koffi" \
                  -mindepth 1 -maxdepth 1 \
                  ! -name "${platform.os}_${platform.cpu}" \
                  -exec rm -rf {} +
              fi

              makeWrapper ${nodejs}/bin/node "$out/bin/antseed" \
                --add-flags "$out/libexec/antseed/bundle.mjs" \
                --prefix PATH : ${lib.makeBinPath [ nodejs ]}
            '';

            meta = {
              description = "AntSeed Network CLI — P2P network for AI services";
              homepage = "https://github.com/antseed/antseed";
              license = lib.licenses.gpl3Only;
              mainProgram = "antseed";
              platforms = systems;
            };
          };
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/antseed";
        };
      });
    };
}
