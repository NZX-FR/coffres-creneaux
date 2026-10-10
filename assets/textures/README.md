# Textures HD facultatives

Le jeu dessine toutes ses textures par code (elles ne coûtent aucune bande passante).
Tu peux en remplacer certaines par de vraies images HD : déposées sur GitHub, elles sont
servies **gratuitement par jsDelivr** (pas par Netlify).

## Où les mettre

`assets/textures/` dans ton dépôt, avec le fichier `pack.json` :

```json
{
  "textures": {
    "floor": "sol.webp",
    "brick": "briques.webp",
    "stone": "pierre.webp",
    "slab":  "dalles.webp"
  }
}
```

| Clé | Surface | Taille conseillée |
|---|---|---|
| `floor` | sol des salles (se répète) | 512 × 512 |
| `brick` | murs en briques | 512 × 512 |
| `stone` | pierre des créneaux / socles | 256 × 256 |
| `slab` | dalles sombres | 256 × 256 |

Les images sont **teintées automatiquement** selon le thème de chaque château : prends des textures plutôt claires et neutres (grises).
Elles doivent **se répéter sans raccord visible** (« seamless / tileable »).

## Où trouver des textures gratuites (CC0, aucune obligation)

- ambientCG — <https://ambientcg.com> (catégories *Bricks*, *PavingStones*, *Tiles*)
- Poly Haven — <https://polyhaven.com/textures>

Télécharge la version 1K, garde seulement l'image « Color / Albedo », puis convertis-la en **WebP** (par ex. <https://squoosh.app>, qualité 75) : une texture 512 × 512 pèse alors 30 à 80 Ko.

## Important

- Le dépôt GitHub doit être **public** pour que jsDelivr puisse servir les fichiers.
- jsDelivr garde une copie jusqu'à 12 h : une texture modifiée peut mettre quelques heures à apparaître. Pour forcer, change le nom du fichier (ex. `sol-v2.webp`) dans `pack.json`.
- Si une image manque, le jeu garde simplement sa texture dessinée par code.
