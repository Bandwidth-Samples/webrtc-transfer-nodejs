import express from "express";
import bodyParser from "body-parser";
import BandwidthWebRTC from "@bandwidth/webrtc";
import BandwidthVoice from "@bandwidth/voice";
import { v1 as uuidv1 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(bodyParser.json());
app.use(express.static("public"));

// config
const port = process.env.LOCAL_PORT || 3000;
const accountId = process.env.BW_ACCOUNT_ID;
const username = process.env.BW_USERNAME;
const password = process.env.BW_PASSWORD;

// Check to make sure required environment variables are set
if (!accountId || !username || !password) {
  console.error(
      "ERROR! Please set the BW_ACCOUNT_ID, BW_USERNAME, and BW_PASSWORD environment variables before running this app"
  );
  process.exit(1);
}

// Global variables
const {Client: WebRTCClient, ApiController: WebRTCController} = BandwidthWebRTC;
const webrtcClient = new WebRTCClient({
  basicAuthUserName: username,
  basicAuthPassword: password
});
const webRTCController = new WebRTCController(webrtcClient);

const {Client: VoiceClient, ApiController: VoiceController} = BandwidthVoice;
const voiceClient = new VoiceClient({
  basicAuthUserName: username,
  basicAuthPassword: password
});
const voiceController = new VoiceController(voiceClient);

// track our session IDs and phone call Id
//  - if not a demo, these would be stored in persistent storage
let sessionMap = new Map();

// create a map of PSTN callIds => participant_ids that will persist
let calls = new Map();

/**
 * Setup the call and pass info to the browser so they can join
 */
app.get("/startBrowserCall", async (req, res) => {
  try {
    // create the session - the value we set here in the "tag" field specifies the session
    let session_id = await getSessionId("session#" + req.query.agent_id);
    console.log(
      `Placing agent #${req.query.agent_id} into session '${session_id}'`
    );

    let [participant, token] = await createParticipant(uuidv1());

    await addParticipantToSession(participant.id, session_id);
    // now that we have added them to the session, we can send back the token they need to join
    res.send({
      message: "created participant and setup session",
      token: token,
    });
  } catch (error) {
    console.log("Failed to start the browser call:", error);
    res.status(500).send({ message: "failed to set up participant" });
  }
});

/**
 * Start the Phone Call
 */
app.get("/startPSTNCall", async (req, res) => {
  try {
    const agent_id = req.query.agent_id;
    // start the call first, this will have some lead time (call setup, ringing, etc)
    console.log(
      `start the PSTN call to ${process.env.USER_NUMBER} for agent ${agent_id}`
    );
    let callResponse = await initiateCallToPSTN(
      process.env.BW_NUMBER,
      process.env.USER_NUMBER
    );

    // then set them up in the session
    let sessionId = await getSessionId("session#" + agent_id);
    let [participant, token] = await createParticipant(uuidv1());
    await addParticipantToSession(participant.id, sessionId);

    // store the token and session with the participant for later use, referenced by callId
    participant.token = token;
    participant.session_id = sessionId;
    calls.set(callResponse.result.callId, participant);

    console.log(
      `Call created: ${callResponse.result.callId} from: ${process.env.BW_NUMBER} to: ${process.env.USER_NUMBER}`
    );

    res.send({ status: "ringing" });
  } catch (error) {
    console.log("Failed to start PSTN call:", error);
    res.status(500).send({ message: "failed to set up PSTN call" });
  }
});

/**
 * Bandwidth's Voice API will hit this endpoint when an outgoing call is answered
 */
app.post("/callAnswered", async (req, res) => {
  let callId = req.body.callId;
  console.log(
      `received answered callback for call ${callId} to ${req.body.to}`
  );

  const participant = calls.get(callId);
  if (!participant) {
    console.log(`no participant found for ${callId}!`);
    res.status(200).send(); // have to return 200 to the BAND server
    return;
  }

  // This is the response payload that we will send back to the Voice API to transfer the call into the WebRTC session
  // Use the SDK to generate this BXML
  console.log(
    `webRTC transfer for call ${callId} into session ${participant.session_id}`
  );
  const bxml = WebRTCController.generateTransferBxml(participant.token, callId);

  // Send the payload back to the Voice API
  res.contentType("application/xml").send(bxml);
});

/**
 * Transfer the Phone Call
 */
app.get("/transferPSTNCall", async (req, res) => {
  console.log(
    `Transferring call from agent #${req.query.from_agent_id} to agent #${req.query.to_agent_id}`
  );

  try {
    // get the call that is currently with the from
    const fromSessionId = await getSessionId(`session#${req.query.from_agent_id}`);
    const callId = getCallIdFromSession(fromSessionId);
    const participant = calls.get(callId);
    // get the destination session (TO)
    const toSessionId = await getSessionId(`session#${req.query.to_agent_id}`);

    console.log(`Transfer ${callId} to ${toSessionId}`);

    // updating will automatically destroy the participant's old session subscription
    await updateParticipantSession(participant, fromSessionId, toSessionId);

    // also update the call map, now that the call has moved
    participant.session_id = toSessionId;
    calls.set(callId, participant);

    res.send({ status: "transferred" });
  } catch (error) {
    console.log(
      `error transferring ${process.env.USER_NUMBER}:`,
      error
    );
    res.status(500).send({ status: "call transfer failed" });
  }
});

/**
 * End the Phone Call
 */
app.get("/endPSTNCall", async (req, res) => {
  console.log(`Hanging up PSTN call from agent #${req.query.agent_id}`);

  try {
    const agentSessionId = await getSessionId("session#" + req.query.agent_id);
    const callId = getCallIdFromSession(agentSessionId);
    await endCallToPSTN(callId);
    res.send({ status: "hungup" });
  } catch (error) {
    console.log(
      `error hanging up ${process.env.USER_NUMBER}:`,
      error
    );
    res.status(500).send({ status: "call hangup failed" });
  }
});

/**
 * start our server
 */
app.listen(port, () => {
  console.log(`Example app listening on port http://localhost:${port}`);
});

// ------------------------------------------------------------------------------------------
// All the functions for interacting with Bandwidth WebRTC services below here
//
/**
 * Return the session id
 * This will either create one via the API, or return the one already created for this session
 * @param tag
 * @return a Session id
 */
async function getSessionId(tag) {
  // check if we've already created a session for this call
  //  - this is a simplification we're doing for this demo
  if (sessionMap.has(tag)) {
    return sessionMap.get(tag);
  }

  // otherwise, create the session
  // tags are useful to audit or manage billing records
  const sessionBody = { tag: tag };

  try {
    let sessionResponse = await webRTCController.createSession(
        accountId,
        sessionBody
    );
    // saves it for future use, this would normally be stored with meeting/call/appt details
    saveSessionId(tag, sessionResponse.result.id);

    return sessionResponse.result.id;
  } catch (error) {
    console.log("Failed to create session:", error);
    throw new Error(
      "Error in createSession, error from BAND:" + error.errorMessage
    );
  }
}

/**
 * Imagine we're using persistant storage, we'd be storing our session id here
 * @param tag - the handle for this session, so we can reference it and others can join it
 * @param session_id the id from BAND webrtc
 */
function saveSessionId(tag, session_id) {
  // saved globally for simplicity of demo
  sessionMap.set(tag, session_id);
}

/**
 * Search through the calls Map, looking for the call in this session
 * @param {*} session_id
 */
function getCallIdFromSession(session_id) {
  let this_call_id = null;
  calls.forEach(function (participant, call_id) {
    if (participant.session_id == session_id) {
      this_call_id = call_id;
    }
  });

  if (this_call_id != null) {
    return this_call_id;
  } else {
    throw new Error(
      `Failed to find the call_id for this session: ${session_id}`
    );
  }
}

/**
 * Create a new participant
 * @param tag to tag the participant with, no PII should be placed here
 * @return list: (a Participant json object, the participant token)
 */
async function createParticipant(tag) {
  // create a participant for this browser user
  const participantBody = {
    tag: tag,
    publishPermissions: ["AUDIO"],
    deviceApiVersion: "V3"
  };

  try {
    let createResponse = await webRTCController.createParticipant(
        accountId,
        participantBody
    );

    return [createResponse.result.participant, createResponse.result.token];
  } catch (error) {
    console.log("failed to create Participant", error);
    throw new Error(
        "Failed to createParticipant, error from BAND:" + error.errorMessage
    );
  }
}

/**
 * @param participantId a Participant id
 * @param sessionId The session to add this participant to
 */
async function addParticipantToSession(participantId, sessionId) {
  const body = { sessionId: sessionId };

  try {
    await webRTCController.addParticipantToSession(
        accountId,
        sessionId,
        participantId,
        body
    );
  } catch (error) {
    console.log("Error on addParticipant to Session:", error);
    throw new Error(
        "Failed to addParticipantToSession, error from BAND:" + error.errorMessage
    );
  }
}

/**
 * @param participantId a Participant id
 * @param sessionId The session to remove this participant from
 */
async function removeParticipantFromSession(participantId, sessionId) {
  try {
    await webRTCController.removeParticipantFromSession(
        accountId,
        sessionId,
        participantId
    );
  } catch (error) {
    console.log("Error on removeParticipantFromSession:", error);
    throw new Error(
        "Failed to removeParticipantFromSession, error from BAND:" + error.errorMessage
    );
  }
}

/**
 * Update the session for this participant
 * @param {participant} participant
 * @param {string} old_session_id The session we're coming from
 * @param {string} new_session_id The session we're going to
 */
async function updateParticipantSession(
  participant,
  old_session_id,
  new_session_id
) {
  try {
    await removeParticipantFromSession(participant.id, old_session_id)
    await addParticipantToSession(participant.id, new_session_id);
  } catch (error) {
    console.log("Error on update participant session:", error);
    throw new Error(
      "Failed to update participant session, error from BAND:" + error.errorMessage
    );
  }
}

/**
 * Start a call out to the PSTN
 * @param from_number the FROM on the call
 * @param to_number the number to call
 */
async function initiateCallToPSTN(fromNumber, toNumber) {
  // call body, see here for more details: https://dev.bandwidth.com/voice/methods/calls/postCalls.html
  const body = {
    from: fromNumber,
    to: toNumber,
    applicationId: process.env.BW_VOICE_APPLICATION_ID,
    answerUrl: process.env.BASE_CALLBACK_URL + "/callAnswered",
    answerMethod: "POST",
    callTimeout: "30",
  };

  return await voiceController.createCall(accountId, body);
}

/**
 * End the PSTN call
 * @param call_id The id of the call
 */
async function endCallToPSTN(callId) {
  // call body, see here for more details: https://dev.bandwidth.com/voice/methods/calls/postCallsCallId.html
  const body = {
    state: "completed",
    redirectUrl: "foo"
  };
  try {
    await voiceController.modifyCall(accountId, callId, body);
  } catch (error) {
    console.log("Failed to hangup the call", error);
    throw error;
  }
}
