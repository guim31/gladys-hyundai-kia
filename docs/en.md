# Hyundai / Kia

Follow and control your Hyundai or Kia car from Gladys through the cloud of the
official apps (**Bluelink** for Hyundai, **Kia Connect** for Kia), European
accounts only for now.

## What you get

One Gladys device per car of the account, with:

- **Electric and plug-in hybrid cars**: battery level, electric range, charging
  state, plugged in, start / stop charging, AC and DC charge limits, time left
  to full charge.
- **All cars**: range (total range for a hybrid or combustion car), climate
  on / off with its set temperature, doors locked / unlocked (lock and unlock),
  door or trunk open, window open, odometer, 12 V battery, engine on.
- **Newer cars** (2024 and later, such as the EV9 or the IONIQ 5 facelift):
  outside temperature too.

A dashboard widget **Vehicle** shows the battery, the range, the charging and
climate state, the doors and the last update, with buttons for the climate,
charging, locks and a refresh. Two scene actions are available: **Refresh a
Hyundai / Kia vehicle** (outputs the battery level and the range) and **Start the
climate of a Hyundai / Kia** (temperature and duration can be set in the scene).

## Configuration

1. Make sure the car works in the official app (Bluelink or Kia Connect) and
   that you accepted its latest terms.
2. In Gladys, open the integration, choose the **brand**, then enter the
   **e-mail address** and **password** of the account.
3. Enter the **PIN** (4 digits) of the account if your car is recent: newer
   cars refuse any command without it. Older cars do not need it.
4. Choose the **account language** (the language of the app account) and save.
5. Click **Test the connection**: the cars of the account are listed.
6. In the **Discover** tab, add your car to Gladys.

**Refresh token instead of the password**: if the sign-in keeps failing, you
can paste a 48-character refresh token (obtained with the tools of the
hyundai_kia_connect_api project) in the password field.

The password, PIN and tokens never leave the container except towards the
Hyundai / Kia cloud, and are never written in the logs. The session tokens are
kept in `/data`.

## How fresh is the data?

By default, the integration reads **the last state the car sent to the cloud**
every 30 minutes (15, 30 or 60). That read does not wake the car: the car sends
its state itself when it is switched off, plugged in, or after a command.

**Forced refresh** asks the car itself for its state. It wakes the car's modem
and uses its 12 V battery, and the cloud limits the number of daily requests.
It is **off by default**; when enabled (every 2, 4, 8 or 12 hours), it never
runs between 10 pm and 6 am nor while the engine is on. The widget's
**Refresh** button and the **Refresh a Hyundai / Kia vehicle** scene action force a
read at any time.

## Commands

A command goes through the cloud to the car, which can take from a few seconds
to two minutes. Gladys shows the expected value once the car confirms it; if
the car does not answer, the real state comes back with the next read.

- **Climate**: starts with the set temperature (16 to 30 °C, kept by the
  integration, 21 °C by default) for the duration chosen in the configuration.
- **Charge limits**: 50 to 100 % by steps of 10.
- **Unlock**: the widget asks for a confirmation first.

## Limits

- European accounts only (not North America, China, Australia or India).
- Developed without a real car or a real account: please report what works and
  what does not on the Gladys forum.
- Nothing about the car's position is read or published.

## Troubleshooting

- **"The account refused the sign-in"**: check the brand, e-mail and password.
- **"Your account asks you to accept new terms"**: open the official app, sign
  in, accept, then save the configuration again.
- **"The sign-in pages refused the connection"**: too many sign-ins in a short
  time; wait a few hours before saving again.
- **"This car needs the PIN"**: enter the PIN of the account in the
  configuration.
- **"The daily request quota is spent"**: the integration pauses for an hour;
  lower the refresh frequency or turn the forced refresh off.
