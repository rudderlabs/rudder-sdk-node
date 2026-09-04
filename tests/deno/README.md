# Deno compatibility tests

The core SDK compatibility range is Deno 2.9.6 and later within Deno 2.x. CI tests the minimum
version and the current stable release. A future stable major version is only a forward
compatibility signal until the supported range changes explicitly.

Run the suite with:

```sh
npm run test:deno
```

The command builds and packs the current repository. It then extracts and links the package into
an isolated Deno test project. The tests use a local HTTP receiver and do not require RudderStack
credentials.

The suite grants network access only to `127.0.0.1`. The package currently requires unrestricted
environment access because the transitive `debug` dependency enumerates `process.env`. A scoped
permission such as `--allow-env=DEBUG` is not sufficient. The CI permission check protects this
known boundary.

The optional Bull and Redis persistence queue is outside this suite. SDK-5397 tracks that
compatibility assessment separately.
