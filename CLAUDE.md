# thebaroness-back

API Express 5 / TypeScript / MongoDB du projet thebaroness (tracker Deadlock). Le front est dans `../thebaroness-front` (dépôt `luminescencedev/thebaroness`, développé par Arthur avec son propre Claude).

## Liaison avec le Claude du front

- **Avant de travailler** : `git -C ../thebaroness-front pull`, puis lire `../thebaroness-front/docs/HANDOFF.md` (front vers back) et ses contrats `docs/back-*.md`. `src/api/types.ts` et `src/mocks/handlers.ts` du front font référence pour les formes et les statuts.
- **À chaque rapport rendu à l'utilisateur** : mettre à jour `docs/HANDOFF.md` de ce dépôt (back vers front) : état des routes, changements de contrat (journal), réponses aux questions du front, décisions tranchées, écarts. Commit et push sur `main` pour qu'Arthur le récupère au pull.
- Tout changement de route, de forme JSON, de statut, de variable d'env, de port ou de commande : mettre à jour `src/docs/openapi.ts`, lancer `npm run openapi`, et l'inscrire dans `docs/HANDOFF.md` avec un exemple.

## Règles

- Jamais de co-auteur Claude ni de mention Claude dans les commits, PR et issues.
- Une issue GitHub par chantier, une PR par issue (squash), tests verts avant merge.
- Valeur inconnue : `null`, jamais 0. Erreurs : `{ error: { code, message } }`. SteamID64 toujours en chaîne.
- Aucun appel réseau réel dans les tests (fetch injecté, Mongo en mémoire).
- Contrats du front : `back-steam-contract.md`, `back-p1-contract.md`, `back-groups-contract.md`. En cas de conflit avec le cahier des charges, ils priment.
