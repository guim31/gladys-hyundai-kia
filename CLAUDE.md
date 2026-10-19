# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/vehicle.test.js          # one file
node --test --test-name-pattern "CCS2"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/hyundaiKia.js                 runtime: cars, reads (cached / forced), commands, overrides, errors
src/bluelink/auth.js              EU sign-in (CCI OneApp, 5 steps) or legacy refresh token, Stamp
src/bluelink/client.js            CCAPI calls: vehicles, status (original / CCS2), commands, results
src/bluelink/http.js, errors.js   fetch wrapper; cloud error codes -> error kinds
src/bluelink/constants.js         per-brand app ids, hosts and keys (from hyundai_kia_connect_api)
src/devices/vehicle.js            raw status -> snapshot, Gladys device, states, commands
src/store.js                      /data/hyundai-kia.json: tokens + per-car state (0600, atomic)
src/scenes.js                     scene actions refresh_vehicle, start_climate
src/widgets.js                    dashboard widget `vehicle`
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test; helpers/ fake Gladys, fake fetch, fake Bluelink client
test/fixtures/bluelink/           cloud answers (adapted from hyundai_kia_connect_api, anonymized)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** comes in four languages (`en`, `fr`, `de`, `es`):
  action messages, widget and error texts, manifest texts
  (`test/i18n.test.js`). The documentation is `docs/en.md` / `docs/fr.md`,
  kept in sync.
- **Logs.** Info level is for the lifecycle only (start, sign-in, cars found,
  one line per user command, a failure and its recovery). A failure that
  repeats on every read is logged once (warn), then at debug level until it
  recovers (`logFailure` / `logRecovery`); the connection status is sent only
  when it changes. `LOG_LEVEL=debug` shows the rest. Never a token, password,
  PIN or full VIN. `test/hyundaiKia.test.js` checks a normal cycle writes
  nothing at info level.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

---

# Notes du mainteneur (guim31)

Ce qui suit complète les règles du template ci-dessus. Ce sont des faits vérifiés dans le code du
cœur Gladys ou payés sur les intégrations déjà publiées par guim31. Ils ne se lisent pas dans le
code de ce dépôt. Compléter ce fichier quand un nouveau piège est découvert.

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test`. Prettier contrôle **aussi le Markdown** : lancer `npm run format` après avoir
  modifié ce fichier, le README ou la documentation, sinon la CI tombe.
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel se fait ailleurs.
  Le dire, plutôt que de conclure que « ça marche ».
- **Tout le code de démonstration du template disparaît** : station météo, prise, lampe, caméra,
  capteur de mouvement, `src/weather.js`, leurs tests, leurs entrées du manifeste et de la
  documentation. Il ne reste que ce que l'intégration fait vraiment.
- **Publier n'est jamais le travail d'une session de code** : ni Release, ni tag, ni topic, ni
  version modifiée à la main. L'orchestrateur s'en charge une fois la PR fusionnée. Les workflows
  sont ceux du template : ne pas les modifier.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe, **en millisecondes** (1000, 2000, 10000,
  15000, 30000, 60000). Le template publie `poll_frequency: 300` sans `should_poll` : c'est faux,
  le cœur répond 400 à la découverte. Pour une cadence hors liste, publier `should_poll: false` et
  pousser les états depuis le conteneur, en gardant un `onPoll` de repli.
  Gladys 5.2.0 (issue GladysAssistant/Gladys#3198) ne sonde pas non plus les appareils **déjà
  créés** sans `should_poll` : ne jamais compter sur `onPoll`. Ici, le minuteur de
  `src/hyundaiKia.js` (une minute, lectures selon `refresh_minutes`) fait tout ; `onPoll` ne
  republie que ce qui a changé, sans appel au cloud. Un test le prouve sans aucun `onPoll`.
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- Un état publié sur une fonctionnalité **pas encore ajoutée** dans Gladys reçoit un 200 puis est
  jeté (simple ligne de log) : republier les états dans `onDeviceCreated`.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- **Détecteur d'ouverture (`opening-sensor`) : 0 = ouvert, 1 = fermé** (`OPENING_SENSOR_STATE`), à
  l'inverse de l'intuition et des autres détecteurs (mouvement, fuite, fumée : 1 = détecté). Une
  porte ouverte publiée à 1 s'affiche « Fermé » et fausse scènes et historique. Le figer par un test.
- **Un `external_id` de fonctionnalité ne change jamais d'appareil** d'une version à l'autre. UniFi
  1.5.2 avait sorti les ports PoE dans un appareil dédié, la 1.6.0 les a remis dans la passerelle avec
  les mêmes identifiants : ceux qui avaient ajouté l'appareil dédié ne peuvent plus « Mettre à jour » la
  passerelle (409 `external_id must be unique`). Pour regrouper, garder l'appareil existant
  (`gladys.getDevices()`) ou changer d'identifiant.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié.
- **Aucune commande d'appareil ne permet un choix multiple** : un `text/select` n'a qu'un choix
  actif.
- Un changement de structure fait proposer « Mettre à jour » dans l'onglet Découverte
  (`structure_changed`). Un changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language` si des textes partent du
  conteneur. Le superviseur injecte `TZ`, le fuseau de Gladys. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus **sans `step`** : le navigateur n'accepte alors que `min + k`.
  Min et défaut **entiers** seulement ; une valeur décimale passe par un `select` ou par un
  `string` parsé (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir, et une action
  n'applique **aucun `default`** tout en exigeant les champs `required` (422). Issues
  GladysAssistant/Gladys#3154 et #3155.
- **Résultat d'une action : deux niveaux seulement** (5.1.4). Résolu = vert, levé = rouge, pas
  d'avertissement. Lever une erreur dont le `message` est un objet `{ en, fr }` : le SDK 0.14
  l'envoie tel quel, le cœur le relaie intact et le navigateur choisit la langue (le SDK n'a pas
  de classe `ActionFailure` : la définir soi-même). Une action ne reçoit **pas** le formulaire en
  cours : elle travaille sur la configuration enregistrée, et son résultat reste affiché sous le
  bouton après « Enregistrer ».
- **Une commande d'appareil refusée** (`onDeviceSetValue` qui lève) ne finit que dans les journaux
  du cœur, sans toast ; il n'enregistre alors pas la valeur demandée. Republier la valeur connue
  pour défaire l'affichage optimiste, et montrer la raison ailleurs (widget).

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- **Cibler la dernière version publiée du cœur, pas `master`** : la spec de `master` décrit des
  fonctions non publiées. Les boutons de widget qui ouvrent un formulaire (#3168, commit 3feb2cf8)
  sont absents de la 5.1.4 : le bouton s'affiche et n'envoie rien. Vérifier par `git tag --contains`.

- Un réglage de widget ne propose en liste que les **appareils** de l'intégration
  (`source: "devices"`, seule source dynamique).
- Budget du cœur : **8 composants par widget, dont 2 textes au plus**, appliqué **avant** la
  résolution des références ; un contenu amputé reste en cache jusqu'au TTL. Appeler
  `requestWidgetRefresh` à la création d'un appareil. `validateWidgetContent` est exporté pour les
  tests, mais ne vérifie pas que les `external_id` liés existent : les croiser avec `buildDevice`.
- Une ligne de `status` exige un `value` (nombre ou texte ≤ 40).
- Une action de widget **résolue** s'affiche en neutre ; **levée**, en rouge (« Action échouée —
  message »), le message réduit à une chaîne (`${error.message}`, 200 caractères). L'action ne
  reçoit pas la langue du lecteur (la lecture du widget, si).
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées.
- Le vocabulaire des widgets n'a ni liste ni curseur, **par choix** du cœur. Seul un bouton
  `device_feature` numérique a un état actif natif.
- **En mode sombre, le style `primary` d'un bouton de widget ne se voit pas** (#3153) : signaler
  un choix courant par l'icône (`check-circle`), jamais par le style.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s. Un toast d'action est tronqué à 200 caractères.
- Le cœur met le contenu d'un widget en cache par (réglages, langue, unités) : pré-localiser
  d'après `language` est correct.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil reste le travail d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- `gladys_version` `>=5.1.0` dès qu'il y a widgets, déclencheurs ou actions de scène.

## Hyundai / Kia (Europe)

- Protocole repris de `hyundai_kia_connect_api` (MIT, `THIRD_PARTY_NOTICES.md`) : hôtes, app ids,
  clés `cfb` du header `Stamp`, codes d'erreur. Aucune réponse réelle n'a été capturée ici : le
  proxy des sessions de code n'a ni compte ni voiture. Les fixtures viennent des tests de cette
  bibliothèque, anonymisées (VIN, ids et position retirés).
- **Connexion** : l'ancien login par formulaire est mort ; l'UE passe par le parcours CCI
  « OneApp » (authorize, clé RSA publique, `signin` avec mot de passe chiffré, échange du code,
  `token-exchange?serviceType=CCS`). Une redirection vers `/web/v1/user/authorization` = conditions
  à accepter dans l'appli ; une page « Your request was rejected » = pare-feu (trop de connexions).
  Ces deux cas et un refus d'identifiants **arrêtent tout** jusqu'au prochain enregistrement de la
  configuration : réessayer ferait bloquer le compte. Un jeton de rafraîchissement « legacy » de
  48 caractères dans le champ mot de passe court-circuite le formulaire.
- **X-Fingerprint (depuis le 14/10/2026)** : `/auth/v1/token`, `/auth/v2/token-refresh` et
  `/auth/v1/token-exchange` de `cci-api-eu` exigent un HMAC-SHA256 de l'identité de l'appli Android
  OneApp 1.4.0 (`computeFingerprint`, clés par marque dans `constants.js`, upstream #1352). Les
  routes `domain/api` non signées ne servent qu'en repli, sur les codes 9035-9037 du portail. Les
  clés tournent avec les versions de l'appli : un 9036 généralisé = clés à mettre à jour.
- Les jetons tournent et vivent dans `/data/hyundai-kia.json` (0600, écriture atomique), jamais
  dans la configuration ni les journaux. Un `deviceId` refusé (4002) est réenregistré.
- **Deux protocoles**, choisis par `ccuCCS2ProtocolSupport` de la liste des voitures :
  l'ancien (`vehicleStatus`, heure en **heure de Berlin**) et CCS2 (arbre `Vehicle`, `Date` en UTC,
  parfois suffixée `.000`). Sur CCS2, `Door.*.Lock: false` veut dire **verrouillée**, et une
  batterie 12 V avec `SensorReliability: 1` ou hors 0–100 est inconnue, pas 0 %.
- Les commandes CCS2 exigent un jeton de contrôle obtenu par le **PIN** du compte
  (`PUT /api/v1/user/pin`, mis en cache) ; l'ancien protocole n'en veut pas. Le résultat d'une
  commande se lit dans les notifications (`records`), pas dans sa réponse.
- Retour réel (IONIQ 5, 10/2026) : le cloud a demandé le PIN pour un déverrouillage. Notre client
  ne lève « needs the PIN » que sur le chemin CCS2 : le cloud listait donc cette voiture en CCS2.
  Le PIN est demandé à tous dans la configuration ; le protocole de chaque voiture est journalisé
  au démarrage.
- Lecture « en cache » (dernier état envoyé par la voiture) sans réveil ; lecture **forcée** =
  réveil du modem, 12 V et quota quotidien (5091) : désactivée par défaut, jamais de 22 h à 6 h ni
  moteur allumé. Quota épuisé : pause d'une heure.
- Après une commande confirmée, ses valeurs restent publiées jusqu'à un état de la voiture daté
  d'après la commande : l'état « en cache » est souvent plus vieux et ferait clignoter Gladys.
- La consigne de climatisation n'existe pas dans le cloud : elle est gardée dans `/data`.
- La position GPS n'est **jamais** lue ni publiée (dépôt public, vie privée).

## Store

- Validateur officiel, depuis la racine : `npx -y github:GladysAssistant/integration-store .`
  (schéma, `description` **100 caractères au plus par langue**, documentation de 300 caractères
  au moins, image Docker, cover de **150 Ko au plus**). Il demande Node ≥ 24 mais tourne sous
  Node 22 avec un avertissement.
- L'indexeur lit le manifeste de la **dernière release**, pas celui de `main` : une correction du
  manifeste (catégorie, description…) n'atteint le store qu'avec une release.
- L'indexeur rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  `https://integration-store-storage.gladysassistant.com/index.json`.
- **Image de base** : `FROM public.ecr.aws/docker/library/node:…` (miroir officiel ECR Public, même
  empreinte) et non `node:…` de Docker Hub, qui refuse en 429 les pulls anonymes des runners GitHub
  dès qu'il y a plusieurs builds à la fois. Un échec 429 dans le job « Docker build » n'est pas un bug
  du code. Même parade dans `.github/workflows/build.yml` (posée par l'orchestrateur, ne pas la
  retirer) : QEMU et BuildKit tirés de `mirror.gcr.io`.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi.
