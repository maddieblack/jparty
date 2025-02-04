
import {
    HostServerSocket, HostSocket, HostSocketCallback, ServerSocket, ServerSocketMessage, SessionState, SessionTimeoutType,
    TriviaGameSettings, TriviaGameSettingsPreset, VoiceType
} from "jparty-shared";
import { generate as generateRandomWord } from "random-words";
import { Socket } from "socket.io";

import { createSession, deleteSession, emitLeaderboardUpdate, emitServerError, emitStateUpdate, emitTriviaRoundUpdate, getSession, joinSessionAsHost, restartTimeout } from "./session-utils.js";
import { io } from "../controller.js";
import { debugLog, DebugLogType } from "../misc/log.js";

function handleConnect(socket: Socket, clientID: string) {
    let sessionName = "";

    do {
        sessionName = generateRandomWord({ minLength: 3, maxLength: 5 }) as string;
    } while (getSession(sessionName));

    createSession(sessionName, socket.id, clientID);
    joinSessionAsHost(socket, sessionName);
}

function handleUpdateGameSettingsPreset(socket: Socket, sessionName: string, gameSettingsPreset: TriviaGameSettingsPreset) {
    let session = getSession(sessionName);
    if (!session || (session.state !== SessionState.Lobby)) {
        return;
    }

    if (socket.id !== session.creatorSocketID) {
        return;
    }

    session.triviaGameSettingsPreset = gameSettingsPreset;

    io.to(Object.keys(session.hosts)).except(socket.id).emit(HostServerSocket.UpdateGameSettingsPreset, gameSettingsPreset);
}

function handleUpdateVoiceType(socket: Socket, sessionName: string, voiceType: VoiceType) {
    let session = getSession(sessionName);
    if (!session) {
        return;
    }

    debugLog(DebugLogType.Voice, `updating session (${sessionName}) to use voice type: ${voiceType}`);

    session.voiceType = voiceType;
    io.to(Object.keys(session.hosts)).emit(HostServerSocket.UpdateVoiceType, voiceType, !process.env.USE_OPENAI_TTS /* modernVoicesDisabled */);
}

function handleUpdateVoiceDuration(socket: Socket, sessionName: string, voiceLine: string, durationSec: number) {
    let session = getSession(sessionName);
    if (!session) {
        return;
    }

    if (socket.id !== session.creatorSocketID) {
        return;
    }

    if (voiceLine !== session.currentVoiceLine) {
        return;
    }

    // an estimated voice duration timeout will have already started, but now that we know exactly how long it will take...
    // we can restart the timeout with a much more accurate duration
    debugLog(DebugLogType.Voice, `got a new duration of ${durationSec} seconds for current voice line: "${session.currentVoiceLine}"`);

    const durationMs = durationSec * 1000;

    if (session.currentAnnouncement) {
        restartTimeout(sessionName, SessionTimeoutType.Announcement, durationMs);
    }

    switch (session.state) {
        case SessionState.ReadingCategoryNames:
            {
                restartTimeout(sessionName, SessionTimeoutType.ReadingCategoryName, durationMs);
            }
        case SessionState.ReadingClueSelection:
            {
                restartTimeout(sessionName, SessionTimeoutType.ReadingClueSelection, durationMs);
            }
            break;
        case SessionState.ReadingClue:
            {
                restartTimeout(sessionName, SessionTimeoutType.ReadingClue, durationMs);
            }
            break;
    }
}

function handleAttemptSpectate(socket: Socket, sessionName: string, clientID: string) {
    let session = getSession(sessionName);
    if (!session) {
        socket.emit(ServerSocket.Message, new ServerSocketMessage(`Couldn't find session a session named: ${sessionName}`, true));
        return;
    }

    if (Object.keys(session.hosts).includes(socket.id)) {
        socket.emit(ServerSocket.Message, new ServerSocketMessage(`Already a host in session: ${sessionName}`, true));
        return;
    }

    session.connectHost(socket.id, clientID);
    joinSessionAsHost(socket, sessionName);

    socket.emit(ServerSocket.Message, new ServerSocketMessage(`Joined session: ${sessionName} as spectator`));

    // we're moving to a new session. make sure our current session knows we're leaving
    handleLeaveSession(socket, (socket as any).sessionName);
}

function handleLeaveSession(socket: Socket, sessionName: string) {
    let session = getSession(sessionName);
    if (!session) {
        return;
    }

    debugLog(DebugLogType.ClientConnection, `socket ID (${socket.id}) is leaving session: ${session.name}`);

    session.disconnectHost(socket.id);

    if (socket.id === session.creatorSocketID) {
        deleteSession(sessionName);
        socket.broadcast.to(sessionName).emit(ServerSocket.CancelGame);
    }
}

async function handleGenerateCustomGame(socket: Socket, sessionName: string, gameSettings: TriviaGameSettings, callback: HostSocketCallback[HostSocket.GenerateCustomGame]) {
    let session = getSession(sessionName);
    if (!session || (session.state !== SessionState.Lobby)) {
        return;
    }

    if (socket.id !== session.creatorSocketID) {
        return;
    }

    try {
        await session.generateTriviaGame(gameSettings);
    }
    catch (e) {
        emitServerError(e, socket);
        callback(false);
        return;
    }

    io.to(Object.keys(session.hosts)).emit(HostServerSocket.UpdateGameSettingsPreset, TriviaGameSettingsPreset.Custom);
    socket.emit(ServerSocket.Message, new ServerSocketMessage("Custom settings were saved successfully"));
    emitTriviaRoundUpdate(sessionName);
    callback(true);
}

function handlePlayAgain(socket: Socket, sessionName: string) {
    let session = getSession(sessionName);
    if (!session || (session.state !== SessionState.GameOver)) {
        return;
    }

    session.resetGame();
    emitStateUpdate(sessionName);
    emitTriviaRoundUpdate(sessionName);
    emitLeaderboardUpdate(socket);
}

const handlers: Record<HostSocket, Function> = {
    [HostSocket.Connect]: handleConnect,
    [HostSocket.UpdateGameSettingsPreset]: handleUpdateGameSettingsPreset,
    [HostSocket.UpdateVoiceType]: handleUpdateVoiceType,
    [HostSocket.UpdateVoiceDuration]: handleUpdateVoiceDuration,
    [HostSocket.AttemptSpectate]: handleAttemptSpectate,
    [HostSocket.LeaveSession]: handleLeaveSession,
    [HostSocket.GenerateCustomGame]: handleGenerateCustomGame,
    [HostSocket.PlayAgain]: handlePlayAgain
}

export default function handleHostEvent(socket: Socket, event: HostSocket, ...args: any[]) {
    try {
        // handle any events that could occur before this host has joined a session
        // (these handlers won't take sessionName as their second param like all the other ones do)
        if ((event === HostSocket.Connect) || (event === HostSocket.AttemptSpectate)) {
            handlers[event](socket, ...args);
            return;
        }

        const sessionName = (socket as any).sessionName;
        handlers[event](socket, sessionName, ...args);
    }
    catch (e) {
        emitServerError(e, socket);
    }
}