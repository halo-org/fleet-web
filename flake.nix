{
  description = "A small browser UI for Fleet";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    ci = {
      url = "github:halo-org/ci";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      ci,
      ...
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (pkgs) lib;
      nodejs = pkgs.nodejs_24;

      certificates = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";

      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.difference ./. (
          lib.fileset.unions [
            ./.github
            ./flake.lock
            ./flake.nix
            (lib.fileset.maybeMissing ./node_modules)
          ]
        );
      };

      fleet-web = pkgs.buildNpmPackage {
        pname = "fleet-web";
        version = "0.0.0";
        inherit nodejs;
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./package-lock.json
            ./server.mjs
            ./public
          ];
        };
        npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
        npmConfigHook = pkgs.importNpmLock.npmConfigHook;
        dontNpmBuild = true;
        postInstall = ''
          makeWrapper ${lib.getExe nodejs} $out/bin/fleet-web \
            --add-flags $out/lib/node_modules/fleet-web/server.mjs
        '';
        meta.mainProgram = "fleet-web";
      };

      image = ci.lib.ociImage system {
        name = "fleet-web";
        entrypoint = [ (lib.getExe fleet-web) ];
        env = {
          SSL_CERT_FILE = certificates;
          HOST = "0.0.0.0";
        };
        layers = [
          pkgs.stdenv.cc.cc.lib
          nodejs
          pkgs.cacert
        ];
      };

      npm =
        name: script:
        pkgs.runCommand "fleet-web-${name}" { nativeBuildInputs = [ nodejs ]; } ''
          cd ${src}
          HOME=$TMPDIR npm run ${script}
          touch $out
        '';
    in
    {
      packages.${system} = {
        inherit fleet-web;
        default = fleet-web;
      };

      ociImages.${system}.fleet-web = image;

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          nodejs
          pkgs.nixfmt
        ];
      };

      checks.${system} = ci.lib.outputChecks self system // {
        check = npm "check" "check";

        test = npm "test" "test";

        nix-fmt = pkgs.runCommand "fleet-web-nix-fmt" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
          nixfmt --check ${./flake.nix}
          touch $out
        '';
      };
    };
}
