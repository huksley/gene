import { env } from "./config";

const API_BASE = "https://api.trello.com/1";

const auth = () => `key=${env.TRELLO_API_KEY}&token=${env.TRELLO_TOKEN}`;

export type TrelloCard = {
  id: string;
  name: string;
  desc: string;
  shortLink: string;
  shortUrl: string;
  idList: string;
  idLabels: string[];
  dateLastActivity: string;
};

export type TrelloComment = {
  id: string;
  idMemberCreator: string;
  date: string;
  data: { text: string };
};

export type TrelloMember = {
  id: string;
  username: string;
  fullName: string;
};

const trelloGet = async <T>(path: string, query: Record<string, string> = {}): Promise<T> => {
  const params = new URLSearchParams({ ...query }).toString();
  const url = `${API_BASE}${path}?${auth()}${params ? `&${params}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Trello GET ${path} failed: ${res.status} ${res.statusText} — ${body}`);
  }
  return res.json() as Promise<T>;
};

export const getCardsInList = async (listId: string): Promise<TrelloCard[]> => {
  return trelloGet<TrelloCard[]>(`/lists/${listId}/cards`, {
    fields: "name,desc,shortLink,shortUrl,idList,idLabels,dateLastActivity"
  });
};

export const getCardComments = async (cardId: string): Promise<TrelloComment[]> => {
  const actions = await trelloGet<TrelloComment[]>(`/cards/${cardId}/actions`, {
    filter: "commentCard",
    limit: "50"
  });
  return actions.sort((a, b) => a.date.localeCompare(b.date));
};

export const getMember = async (memberId: string): Promise<TrelloMember> => {
  return trelloGet<TrelloMember>(`/members/${memberId}`, { fields: "username,fullName" });
};

const trelloPost = async <T>(path: string, body: Record<string, unknown> = {}): Promise<T> => {
  const url = `${API_BASE}${path}?${auth()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(
      `Trello POST ${path} failed: ${res.status} ${res.statusText} — ${await res.text()}`
    );
  }
  return res.json() as Promise<T>;
};

const trelloDelete = async (path: string): Promise<void> => {
  const url = `${API_BASE}${path}?${auth()}`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Trello DELETE ${path} failed: ${res.status} ${res.statusText} — ${await res.text()}`
    );
  }
};

export const addLabelToCard = async (cardId: string, labelId: string): Promise<void> => {
  await trelloPost(`/cards/${cardId}/idLabels`, { value: labelId });
};

export const postComment = async (cardId: string, text: string): Promise<void> => {
  await trelloPost(`/cards/${cardId}/actions/comments`, { text });
};

export const removeLabelFromCard = async (cardId: string, labelId: string): Promise<void> => {
  await trelloDelete(`/cards/${cardId}/idLabels/${labelId}`);
};

const trelloPut = async (path: string, body: Record<string, unknown>): Promise<void> => {
  const url = `${API_BASE}${path}?${auth()}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(
      `Trello PUT ${path} failed: ${res.status} ${res.statusText} — ${await res.text()}`
    );
  }
};

export const moveCard = async (cardId: string, targetListId: string): Promise<void> => {
  await trelloPut(`/cards/${cardId}`, { idList: targetListId, pos: "top" });
};

export type TrelloAttachment = {
  id: string;
  name: string;
  url: string;
  mimeType: string | null;
  fileName: string | null;
  bytes: number | null;
};

export const getCardAttachments = async (cardId: string): Promise<TrelloAttachment[]> => {
  return trelloGet<TrelloAttachment[]>(`/cards/${cardId}/attachments`, {
    fields: "name,url,mimeType,fileName,bytes"
  });
};

/**
 * Downloads an attachment binary. Trello requires OAuth-style Authorization
 * header for download endpoints — query-param auth fails on `/download/...`.
 */
export const downloadAttachment = async (
  cardId: string,
  attachmentId: string,
  fileName: string
): Promise<Buffer> => {
  const url = `${API_BASE}/cards/${cardId}/attachments/${attachmentId}/download/${encodeURIComponent(fileName)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `OAuth oauth_consumer_key="${env.TRELLO_API_KEY}", oauth_token="${env.TRELLO_TOKEN}"`
    }
  });
  if (!res.ok) {
    throw new Error(
      `Trello attachment download failed: ${res.status} ${res.statusText} — ${await res.text()}`
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
};
