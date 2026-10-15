# 📧 Activer l'envoi des mails « mot de passe oublié »

Le serveur envoie les codes de réinitialisation avec **Brevo** (gratuit : 300 mails par jour).
Tant que ce n'est pas configuré, tout le reste marche ; seul « Mot de passe oublié » affiche
« L'envoi de mails n'est pas encore configuré ».

## 1. Créer le compte Brevo
1. Inscris-toi sur https://www.brevo.com (offre gratuite).
2. Menu **Expéditeurs, domaines et IP dédiées → Expéditeurs** → **Ajouter un expéditeur** :
   mets l'adresse qui enverra les mails (par ex. ta Gmail) et valide le lien reçu.
3. Menu **SMTP & API → Clés API** → **Générer une nouvelle clé**. Copie-la (elle commence par `xkeysib-`).

## 2. La donner à Netlify (jamais dans GitHub !)
Netlify → ton site → **Project configuration → Environment variables → Add a variable** :

| Clé | Valeur |
|---|---|
| `BREVO_KEY` | la clé `xkeysib-…` |
| `MAIL_FROM` | l'adresse expéditeur validée à l'étape 1 |
| `MAIL_NAME` | (facultatif) `Coffres & Créneaux` |

Puis **Deploys → Trigger deploy** pour que le serveur prenne les nouvelles variables.

## 3. Tester
Dans le jeu : Se connecter → **Mot de passe oublié ?** → ton nom de compte → tu dois recevoir un code à 6 chiffres.

⚠️ Avec une adresse Gmail comme expéditeur, les mails peuvent arriver dans les **spams**
(ou être refusés par certaines boîtes). Si ça arrive souvent, la solution fiable est un nom de
domaine à toi, déclaré dans Brevo.
