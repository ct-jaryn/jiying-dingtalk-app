import { runDws } from "./dws.js";

// A sender is not necessarily the other person: o2o_all also includes messages
// sent by this account. Verify the peer by CID or a real incoming event with
// an independently verified self ID; names and legacy topic IDs are not proof.
export function createDmIdentityResolver({ query = runDws, topics } = {}) {
  const peers = new Map();
  const pending = new Map();
  const personConversations = new Map();
  let selfIdentity;

  async function request(args) {
    const response = await query(args, { timeoutMs: 15_000 });
    const data = response?.data ?? response;
    if (!data || data.success === false || data.ok === false || data.error) {
      throw new Error("无法读取私聊对象资料，请稍后重试");
    }
    return data;
  }

  function conversation(data) {
    const info = data?.result?.conversationInfo || data?.conversationInfo;
    if (!info || info.singleChat !== true || !clean(info.openConversationId)) {
      throw new Error("未能确认对应的钉钉私聊会话");
    }
    return { id: clean(info.openConversationId), name: clean(info.title) };
  }

  function personConversation(openId) {
    if (!personConversations.has(openId)) {
      const operation = request(["chat", "+conversation-info", "--open-dingtalk-id", openId])
        .then(conversation)
        .catch((error) => {
          personConversations.delete(openId);
          throw error;
        });
      personConversations.set(openId, operation);
    }
    return personConversations.get(openId);
  }

  function trustedRecord(record, cid) {
    if (record?.kind !== "dm" || record.identityVersion !== 1 || !clean(record.openDingTalkId)) return null;
    if (clean(record.dingTalkConversationId) && clean(record.dingTalkConversationId) !== cid) return null;
    return { id: clean(record.openDingTalkId), name: clean(record.name) || clean(record.openDingTalkId) };
  }

  function cachedPeer(cid) {
    if (!peers.has(cid)) {
      const saved = trustedRecord(topics?.byDingTalk?.[cid], cid);
      if (saved) peers.set(cid, saved);
    }
    return peers.get(cid);
  }

  async function findPeer(event, cid) {
    const senderId = clean(event.sender_open_dingtalk_id);
    if (senderId && event.type === "user_im_message_receive_o2o_all") {
      // The real personal event stream supplies both sender and conversation.
      // Once self is known, another sender is already the incoming peer. This
      // also works for system bots whose profile lookup is not permitted.
      let selfId;
      try { selfId = await selfOpenId(); } catch { /* Fall back to CID verification. */ }
      if (selfId && senderId !== selfId) return { id: senderId, name: clean(event.sender) || senderId };
    }
    if (senderId) {
      const sender = await personConversation(senderId);
      if (sender.id === cid) return { id: senderId, name: sender.name || clean(event.sender) || senderId };
    }
    const actual = conversation(await request(["chat", "+conversation-info", "--group", cid]));
    if (actual.id !== cid || !actual.name) throw new Error("未能确认私聊对象，请稍后重试");
    const found = await request(["contact", "user", "search", "--query", actual.name]);
    const candidates = found.result;
    if (!Array.isArray(candidates)) throw new Error("未能读取私聊联系人候选列表");
    const ids = [...new Set(candidates.map((value) => clean(value?.openDingTalkId)).filter(Boolean))];
    const matches = [];
    let failure;
    for (const id of ids) {
      try {
        const candidate = await personConversation(id);
        if (candidate.id === cid) matches.push(id);
      } catch (error) {
        failure = error;
      }
    }
    if (failure) throw new Error("私聊联系人候选未能全部核实，请稍后重试", { cause: failure });
    if (matches.length !== 1) throw new Error("未能唯一找到与钉钉会话 ID 一致的私聊对象，请稍后重试");
    return { id: matches[0], name: actual.name };
  }

  async function peerFor(event) {
    const cid = clean(event.conversation_id);
    if (!cid) throw new Error("私聊消息缺少钉钉会话 ID");
    const cached = cachedPeer(cid);
    if (cached) return cached;
    if (!pending.has(cid)) {
      const operation = findPeer(event, cid).then((peer) => {
        peers.set(cid, peer);
        return peer;
      }).finally(() => pending.delete(cid));
      pending.set(cid, operation);
    }
    return pending.get(cid);
  }

  function selfOpenId() {
    if (!selfIdentity) {
      selfIdentity = (async () => {
        const own = await request(["contact", "user", "get-self"]);
        const rows = Array.isArray(own.result) ? own.result : [own.result];
        const userIds = [...new Set(rows.flatMap((row) => [
          row?.userId, row?.orgUserId, row?.orgEmployeeModel?.userId, row?.orgEmployeeModel?.orgUserId,
        ]).map(clean).filter(Boolean))];
        if (userIds.length !== 1) throw new Error("未能唯一确认当前钉钉用户");
        const [userId] = userIds;
        const search = await request(["contact", "user", "search", "--query", userId]);
        const exact = Array.isArray(search.result)
          ? search.result.filter((value) => clean(value?.userId) === userId && clean(value?.openDingTalkId))
          : [];
        if (exact.length !== 1) throw new Error("未能唯一确认当前钉钉用户 ID");
        return clean(exact[0].openDingTalkId);
      })().catch((error) => {
        selfIdentity = undefined;
        throw error;
      });
    }
    return selfIdentity;
  }

  async function directionFor(event, peer) {
    const senderId = clean(event.sender_open_dingtalk_id);
    if (!senderId) return "unknown";
    if (senderId !== peer.id) return "outgoing";
    // Identity lookup affects the direction label only. Failure cannot replace
    // a peer already proven by the conversation ID with a guessed recipient.
    try {
      return await selfOpenId() === peer.id ? "unknown" : "incoming";
    } catch {
      return "unknown";
    }
  }

  function enriched(event, peer, direction) {
    return { ...event, dm_peer_name: peer.name, dm_peer_open_dingtalk_id: peer.id, dm_direction: direction };
  }

  async function resolve(event) {
    const peer = await peerFor(event);
    return enriched(event, peer, await directionFor(event, peer));
  }

  async function resolveRecord(record) {
    const event = {
      conversation_id: clean(record?.dingTalkConversationId),
      sender: clean(record?.name),
      sender_open_dingtalk_id: clean(record?.openDingTalkId),
    };
    const saved = trustedRecord(record, event.conversation_id);
    if (saved && event.conversation_id) peers.set(event.conversation_id, saved);
    return enriched(event, await peerFor(event), "unknown");
  }

  return { resolve, resolveRecord };
}

function clean(value) {
  return typeof value === "string" && value.trim() !== "null" ? value.trim() : "";
}
