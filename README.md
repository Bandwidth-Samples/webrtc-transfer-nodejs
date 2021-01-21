# WebRTC Cold Transfer

This sample app shows how to setup a call between a browser and a caller, then cold transfer that call to another session in a separate browser, all through Bandwidth's WebRTC and Voice APIs, with NodeJS and minimalist browser-side Javascript.

## Architecture Overview

This app runs an HTTP server that listens for requests from browsers to get connection information. This connection information tells a browser the unique ID it should use to join a WebRTC conference. The HTTP server will also handle requests coming from Bandwidth's Voice API when a phone call comes in.

The server connects to Bandwidth's HTTP WebRTC API, which it will use to create a session and participant IDs. This example leverages our Node SDK to make the WebRTC and Voice API calls.

The web browser will also use a websocket managed by the WebRTC browser SDK to handle signaling to the WebRTC API - this is all handled by a prepackaged Javascript SDK. Once both a browser and a phone have joined the conference, they will be able to talk to each other.

> Note: Unless you are running on `localhost`, you will need to use HTTPS. Most modern browsers require a secure context when accessing cameras and microphones.

## How does a transfer work?

Transfers work by moving a caller between two different WebRTC sessions. You will be calling `removeParticipantFromSession` and then another `addParticipantToSession` when you pull the caller out Agent 1's session and place them in agent 2's session.

Note: Please don't confuse this with Subscriptions - While you can use subscriptions to control who hears audio, which is useful for a Whisper scenario, in this case we should have separate sessions per agent.

## Setting things up

To run this sample, you'll need a Bandwidth phone number, Voice API credentials and WebRTC enabled for your account. Please check with your account manager to ensure you are provisioned for WebRTC.

This sample will need be publicly accessible to the internet in order for Bandwidth API callbacks to work properly. Otherwise you'll need a tool like [ngrok](https://ngrok.com) to provide access from Bandwidth API callbacks to localhost.

### Create a Bandwidth Voice API application

Follow the steps in [How to Create a Voice API Application](https://support.bandwidth.com/hc/en-us/articles/360035060934-How-to-Create-a-Voice-API-Application-V2-) to create your Voice API appliation.

In step 7 and 8, make sure they are set to POST.

In step 9, provide the publicly accessible URL of your sample app. You need to add `/incomingCall` to the end of this URL in the Voice Application settings.

You do no need to set a callback user id or password.

Create the application and make note of your _Application ID_. You will provide this in the settings below.

### Configure your sample app

Copy the default configuration files

```bash
cp .env.default .env
```

Add your Bandwidth account settings to `.env`:

- TRANSFER_ACCOUNT_ID
- TRANSFER_USERNAME
- TRANSFER_PASSWORD

Add your Voice API application information:

- TRANSFER_VOICE_APPLICATION_ID

Enter your local server address (e.g. ngrok url):

- TRANSFER_BASE_CALLBACK_URL

To make an outbound call from the browser, add a phone number to dial:

- TRANSFER_OUTBOUND_PHONE_NUMBER
- TRANSFER_FROM_NUMBER (the number that will appear as the FROM for the call)

### Install dependencies and build

```bash
npm install
node server.js
```

### Communicate!

Browse to [http://localhost:3000](http://localhost:3000) and grant permission to use your microphone.

Follow the instructions on the screen, which are:

1. Choose an agent to log in as (1 agent per browser)
2. Click "Get Online" to start the session Get Online. The web UI will indicate when you are connected.
3. For Agent 1, click "Dial out" to call out to the PSTN number you have set in your configuration
4. Click "Transfer" to send the caller from Agent 1 to agent 2 (you can do this back and forth to your hearts content)
5. You can hang up on the phone or click this button End Call

You should now be able to make calls using your browser and transfer them between agents!

Enjoy!
