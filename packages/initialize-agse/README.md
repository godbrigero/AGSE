# initialize-agse

Create or replace an `agse.config.ts` file in a target repository.

After this package is published to npm, run it from any folder with:

```sh
npx initialize-agse@latest .
```

To install the command globally:

```sh
npm install -g initialize-agse@latest
initialize-agse .
```

For local development from this repository, link the workspace package first:

```sh
npm run link:initialize-agse
initialize-agse /path/to/repo
```
