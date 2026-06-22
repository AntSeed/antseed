{
  description = "AntSeed development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
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
              foundry
              git
              ninja
              nodejs_22
              pkg-config
              pnpm_9
              python311
              solc
            ] ++ lib.optionals stdenv.isLinux [
              libsecret
            ];

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              export npm_config_python="${pkgs.python311}/bin/python3"
              # forge's svm-downloaded solc is dynamically linked and won't run on
              # NixOS; point Foundry at the nix-provided solc instead.
              export FOUNDRY_SOLC="${pkgs.solc}/bin/solc"
            '';
          };
        });
    };
}
