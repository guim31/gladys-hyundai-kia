# Hyundai / Kia

Suivez et pilotez votre Hyundai ou votre Kia depuis Gladys, par le cloud des
applications officielles (**Bluelink** pour Hyundai, **Kia Connect** pour Kia),
pour les comptes européens seulement pour l'instant.

## Ce que vous obtenez

Un appareil Gladys par voiture du compte, avec :

- **Voitures électriques et hybrides rechargeables** : niveau de batterie,
  autonomie électrique, état de charge, branchée, lancer / arrêter la charge,
  limites de charge AC et DC, temps restant avant la fin de la charge.
- **Toutes les voitures** : autonomie (autonomie totale pour une hybride ou une
  thermique), climatisation marche / arrêt avec sa consigne, portes
  verrouillées / déverrouillées (verrouiller et déverrouiller), portière ou
  coffre ouvert, fenêtre ouverte, kilométrage, batterie 12 V, moteur allumé.
- **Voitures récentes** (2024 et après, comme l'EV9 ou l'IONIQ 5 restylée) :
  la température extérieure en plus.

Un widget de tableau de bord **Véhicule** affiche la batterie, l'autonomie,
l'état de la charge et de la climatisation, les portes et le dernier relevé,
avec des boutons pour la climatisation, la charge, le verrouillage et une
actualisation. Deux actions de scène sont disponibles : **Actualiser un véhicule
Hyundai / Kia** (renvoie le niveau de batterie et l'autonomie) et **Lancer la clim
d'une Hyundai / Kia** (température et durée réglables dans la scène).

## Configuration

1. Vérifiez que la voiture fonctionne dans l'application officielle (Bluelink
   ou Kia Connect) et que vous avez accepté ses dernières conditions.
2. Dans Gladys, ouvrez l'intégration, choisissez la **marque**, puis saisissez
   l'**adresse e-mail** et le **mot de passe** du compte.
3. Saisissez le **code PIN** (4 chiffres) du compte : il est nécessaire pour
   les commandes à distance (verrouillage, climatisation, charge). Sans lui, la
   voiture reste suivie.
4. Choisissez la **langue du compte** (celle du compte de l'application) et la
   **langue des noms d'appareils** (anglais, français, allemand ou espagnol :
   Gladys garde les noms donnés à l'ajout de la voiture), puis **enregistrez**.
5. Cliquez sur **Tester la connexion** : les voitures du compte s'affichent. Le
   test utilise la configuration enregistrée, pas le formulaire en cours de
   saisie : enregistrez d'abord. Un résultat reste affiché sous le bouton
   jusqu'au test suivant.
6. Dans l'onglet **Découverte**, ajoutez votre voiture à Gladys.

**Jeton de rafraîchissement à la place du mot de passe** : si la connexion
échoue sans cesse, vous pouvez coller dans le champ mot de passe un jeton de
rafraîchissement de 48 caractères (obtenu avec les outils du projet
hyundai_kia_connect_api).

Le mot de passe, le PIN et les jetons ne quittent le conteneur que vers le
cloud Hyundai / Kia, et ne sont jamais écrits dans les journaux. Les jetons de
session sont conservés dans `/data`.

## Fraîcheur des données

Par défaut, l'intégration lit **le dernier état que la voiture a envoyé au
cloud** toutes les 30 minutes (15, 30 ou 60). Cette lecture ne réveille pas la
voiture : elle envoie son état d'elle-même à l'arrêt, au branchement, ou après
une commande.

L'**actualisation forcée** demande son état à la voiture elle-même. Elle
réveille son modem et puise dans sa batterie 12 V, et le cloud limite le nombre
de requêtes par jour. Elle est **désactivée par défaut** ; une fois activée
(toutes les 2, 4, 8 ou 12 heures), elle ne s'exécute jamais entre 22 h et 6 h
ni moteur allumé. Le bouton **Actualiser** du widget et l'action de scène
**Actualiser un véhicule Hyundai / Kia** forcent une lecture à tout moment.

## Commandes

Une commande passe par le cloud jusqu'à la voiture, ce qui peut prendre de
quelques secondes à deux minutes. Gladys affiche la valeur attendue dès que la
voiture la confirme ; si la voiture ne répond pas, l'état réel revient au
relevé suivant. Une commande refusée remet aussitôt la valeur connue ; le widget
affiche alors la raison en rouge (et une ligne **Commandes** quand le PIN manque
ou est refusé), et l'intégration la note dans ses journaux.

- **Climatisation** : démarre à la consigne (16 à 30 °C, gardée par
  l'intégration, 21 °C par défaut) pour la durée choisie dans la configuration.
- **Limites de charge** : de 50 à 100 % par pas de 10.
- **Déverrouiller** : le widget demande d'abord une confirmation.

## Limites

- Comptes européens seulement (ni Amérique du Nord, ni Chine, ni Australie, ni
  Inde).
- Testée sur une Hyundai IONIQ 5 (compte européen) : connexion et
  déverrouillage ; le reste attend vos retours sur le forum Gladys.
- Rien de la position de la voiture n'est lu ni publié.

## Dépannage

- **« Le compte a refusé la connexion »** : vérifiez la marque, l'adresse
  e-mail et le mot de passe.
- **« Votre compte demande d'accepter de nouvelles conditions »** : ouvrez
  l'application officielle, connectez-vous, acceptez, puis enregistrez à
  nouveau la configuration.
- **« Les pages de connexion ont refusé la connexion »** : trop de connexions
  en peu de temps ; patientez quelques heures avant d'enregistrer à nouveau.
- **« Saisissez le code PIN de votre compte »** : saisissez le PIN du compte
  dans la configuration de l'intégration, puis enregistrez.
- **« Le code PIN de votre compte a été refusé »** : vérifiez le PIN (celui que
  l'application officielle demande pour les commandes), puis enregistrez.
- **« Aucun compte n'est encore enregistré »** après **Tester la connexion** :
  enregistrez la configuration, puis testez à nouveau.
- **« Le quota quotidien de requêtes est épuisé »** : l'intégration fait une
  pause d'une heure ; réduisez la fréquence des relevés ou désactivez
  l'actualisation forcée.
