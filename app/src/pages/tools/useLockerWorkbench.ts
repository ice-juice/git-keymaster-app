import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useApp } from "../../store";
import {
  api,
  entryAttachments,
  errMessage,
  errCode,
  type FileEntry,
} from "../../lib/ipc";
import {
  lockerApi,
  type LockerConnectionStatus,
  type LockerItem,
  type LockerLookup,
  type LockerOperation,
  type LockerPutOptions,
  type LockerSource,
} from "../../lib/locker";
import {
  copyWithClear,
  isNeedReauth,
  tryBiometricReauth,
} from "../../lib/secretsUi";
import {
  buildLockerRules,
  isLockerCode,
  lockerAccessEnded,
  LOCKER_FILE_LIMIT,
  normalizeLockerCode,
  validLockerShareLink,
  lockerFilename,
  type LockerPullChoice,
  type LockerTtlChoice,
} from "../../shared/lockerUi";
import { encodeQrSvg } from "../../shared/qrEncode";
import { useOverlayBack } from "../../shared/mobileBack";
import { isMobilePlatform } from "../../platform/resolve";

export type LockerScreen =
  | "home"
  | "put"
  | "take"
  | "detail"
  | "settings"
  | "service";
type ChosenFile =
  | { kind: "path"; path: string; name: string; size: number }
  | { kind: "file"; file: globalThis.File; name: string; size: number }
  | {
      kind: "vault";
      entryId: string;
      attachmentId: string;
      name: string;
      size: number;
    };
type PutResult = {
  id: string;
  code: string;
  name: string;
  shared: boolean;
  shareError: string;
  operationId: string;
};
type LookupResult = { info: LockerLookup; source: LockerSource };
type ActionConfirm =
  | { kind: "stop" | "delete" | "migrate"; item: LockerItem }
  | { kind: "history" };
function unknownOperation(
  operationId: string,
  kind: "put" | "receive",
  error: string,
): LockerOperation {
  return {
    operationId,
    kind,
    status: "unknown",
    phase: "unknown",
    error,
    recoverable: false,
    updatedAt: new Date().toISOString(),
  };
}
function definitivePreflightGate(error: unknown) {
  return [
    "LOCKED",
    "NOT_INITIALIZED",
    "NEED_REAUTH",
    "BIOMETRIC_CANCELLED",
    "BUSY",
  ].includes(errCode(error) || "");
}
export function activeLockerOperation(op: LockerOperation | null) {
  return (
    !!op &&
    op.status !== "completed" &&
    !(op.status === "failed" && !op.recoverable)
  );
}

export function useLockerWorkbench(
  initialVault?: { entryId: string; attId?: string } | null,
) {
  const { t, i18n } = useTranslation();
  const tr = useCallback(
    (key: string, values?: Record<string, unknown>) =>
      t(`locker.${key}`, values),
    [t],
  );
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const writesLocked = useApp((state) => state.writesLocked);
  const [screen, setScreen] = useState<LockerScreen>("home");
  const [items, setItems] = useState<LockerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [connection, setConnection] = useState<LockerConnectionStatus | null>(
    null,
  );
  const [connectionError, setConnectionError] = useState("");
  const [checking, setChecking] = useState(false);
  const [filter, setFilter] = useState<"active" | "ended" | "all">("active");
  const [search, setSearch] = useState("");
  const [tick, setTick] = useState(Date.now());
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [name, setName] = useState("");
  const [ttl, setTtl] = useState<LockerTtlChoice>("24h");
  const [hours, setHours] = useState("6");
  const [pulls, setPulls] = useState<LockerPullChoice>("1");
  const [customPulls, setCustomPulls] = useState("5");
  const [sharePurpose, setSharePurpose] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [putError, setPutError] = useState("");
  const [putOperation, setPutOperation] = useState<LockerOperation | null>(
    null,
  );
  const [putResult, setPutResult] = useState<PutResult | null>(null);
  const [putBusy, setPutBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const [shareForId, setShareForId] = useState("");
  const [receiveType, setReceiveType] = useState<"own" | "share">("own");
  const [code, setCode] = useState("");
  const [externalLink, setExternalLink] = useState("");
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [takeError, setTakeError] = useState("");
  const [target, setTarget] = useState<"disk" | "vault">("disk");
  const [receiveBusy, setReceiveBusy] = useState(false);
  const [receiveOperation, setReceiveOperation] =
    useState<LockerOperation | null>(null);
  const [operations, setOperations] = useState<LockerOperation[]>([]);
  const [operationBusy, setOperationBusy] = useState("");
  const [detailId, setDetailId] = useState("");
  const [detailCode, setDetailCode] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [confirm, setConfirm] = useState<ActionConfirm | null>(null);
  const [toast, setToast] = useState("");
  const [vaultOpen, setVaultOpen] = useState(false);
  const [vaultEntries, setVaultEntries] = useState<FileEntry[]>([]);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultError, setVaultError] = useState("");
  const [reauth, setReauth] = useState<
    null | ((password: string) => Promise<void>)
  >(null);
  const reauthCancel = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const putGuard = useRef(false),
    receiveGuard = useRef(false),
    shareGuard = useRef(false),
    detailGuard = useRef(false),
    selectingGuard = useRef(false),
    operationGuard = useRef(false);
  const requestSerial = useRef(0),
    sourceSerial = useRef(0),
    refreshSerial = useRef(0),
    secretSerial = useRef(0);
  const screenRef = useRef(screen);
  const putPendingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const putGateId = useRef<string | null>(null);
  const receiveGateId = useRef<string | null>(null);
  screenRef.current = screen;
  const mobile = isMobilePlatform();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reauthCancel.current?.();
      requestSerial.current++;
      sourceSerial.current++;
      secretSerial.current++;
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const withAuth = useCallback(async function withAuth<T>(
    fn: (password?: string) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      if (!isNeedReauth(error)) throw error;
      if (await tryBiometricReauth()) {
        if (!alive.current) return undefined;
        try {
          return await fn();
        } catch (retryError) {
          if (!isNeedReauth(retryError)) throw retryError;
        }
      }
      if (!alive.current) return undefined;
      return new Promise<T | undefined>((resolve, reject) => {
        reauthCancel.current = () => {
          reauthCancel.current = null;
          if (alive.current) setReauth(null);
          resolve(undefined);
        };
        setReauth(() => async (password: string) => {
          try {
            const value = await fn(password);
            reauthCancel.current = null;
            if (alive.current) setReauth(null);
            resolve(value);
          } catch (error) {
            if (["NEED_REAUTH", "BAD_PASSWORD"].includes(errCode(error) || ""))
              throw error;
            // Authentication succeeded but the operation did not. Return to its
            // original operation ledger rather than offering a password retry.
            reauthCancel.current = null;
            if (alive.current) setReauth(null);
            reject(error);
          }
        });
      });
    }
  }, []);
  const reload = useCallback(async () => {
    const serial = ++refreshSerial.current;
    const results = await Promise.allSettled([
      lockerApi.list(),
      lockerApi.connectionStatus(),
      lockerApi.operationsList(),
    ]);
    if (!alive.current || serial !== refreshSerial.current) return;
    if (results[0].status === "fulfilled") {
      setItems(results[0].value.entries);
      setListError("");
    } else setListError(errMessage(results[0].reason));
    if (results[1].status === "fulfilled") {
      setConnection(results[1].value);
      setConnectionError("");
    } else setConnectionError(errMessage(results[1].reason));
    if (results[2].status === "fulfilled")
      setOperations(results[2].value.operations);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
    const id = window.setInterval(() => {
      setTick(Date.now());
      void reload();
    }, 15000);
    const focus = () => void reload();
    window.addEventListener("focus", focus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", focus);
    };
  }, [reload]);
  const onConfigChanged = useCallback(() => {
    void reload();
  }, [reload]);
  const clearSecrets = useCallback(() => {
    secretSerial.current++;
    setShareUrl("");
    setShareForId("");
    setDetailCode("");
    setCode("");
    setExternalLink("");
    setPutResult((previous) => (previous ? { ...previous, code: "" } : null));
    requestSerial.current++;
    setLookup(null);
    setLookupBusy(false);
  }, []);
  const goHome = useCallback(() => {
    clearSecrets();
    setScreen("home");
    setDetailError("");
    setConfirm(null);
    setVaultOpen(false);
  }, [clearSecrets]);
  useOverlayBack(screen !== "home" && screen !== "service" && !reauth, goHome);
  useOverlayBack(vaultOpen, () => setVaultOpen(false));
  const serviceReady =
    !!connection?.serviceReady && !connectionError && !connection?.error;
  const storageReady = !!connection?.storageConfigured && !connectionError;
  const rules = buildLockerRules(ttl, hours, pulls, customPulls);
  const canPut =
    storageReady &&
    ((pulls === "unlimited" && !sharePurpose) || serviceReady) &&
    !writesLocked;
  const putPending = putBusy || activeLockerOperation(putOperation);
  putPendingRef.current = putPending;
  const receivePending = receiveBusy || activeLockerOperation(receiveOperation);
  const detail = items.find((item) => item.id === detailId) || null;
  const filtered = useMemo(
    () =>
      items
        .filter(
          (item) =>
            (filter === "all" ||
              (filter === "ended") === lockerAccessEnded(item, tick)) &&
            `${item.name} ${item.originalName}`
              .toLocaleLowerCase()
              .includes(search.trim().toLocaleLowerCase()),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [items, filter, search, tick],
  );
  const shareSvg = useMemo(() => {
    try {
      return shareUrl ? encodeQrSvg(shareUrl) : "";
    } catch {
      return "";
    }
  }, [shareUrl]);

  async function checkConnections() {
    if (checking) return;
    setChecking(true);
    try {
      const result = await lockerApi.connectionStatus(true);
      if (alive.current) {
        setConnection(result);
        setConnectionError("");
      }
    } catch (error) {
      if (alive.current) setConnectionError(errMessage(error));
    } finally {
      if (alive.current) setChecking(false);
    }
  }
  function openPut() {
    clearSecrets();
    setScreen("put");
    setPutError("");
  }
  function resetPut() {
    if (putBusy || activeLockerOperation(putOperation)) return;
    setChosen(null);
    setName("");
    setPutResult(null);
    setPutOperation(null);
    setPutError("");
    clearSecrets();
    sourceSerial.current++;
  }
  function removeChosen() {
    sourceSerial.current++;
    setChosen(null);
    setName("");
  }
  function selectFile(file: globalThis.File) {
    if (putPending || writesLocked) return;
    sourceSerial.current++;
    if (file.size > LOCKER_FILE_LIMIT) {
      setPutError(tr("tooBig"));
      return;
    }
    setPutOperation(null);
    setPutResult(null);
    clearSecrets();
    setChosen({ kind: "file", file, name: file.name, size: file.size });
    setName(file.name);
    setPutError("");
    setScreen("put");
  }
  const selectPath = useCallback(
    async (path: string) => {
      if (putGuard.current || putPendingRef.current || writesLocked) return;
      const serial = ++sourceSerial.current;
      setSelecting(true);
      try {
        const stat = await lockerApi.sourceStat(path);
        if (!alive.current || serial !== sourceSerial.current) return;
        if (stat.size > LOCKER_FILE_LIMIT) throw new Error(tr("tooBig"));
        setPutOperation(null);
        setPutResult(null);
        clearSecrets();
        setChosen({ kind: "path", path, ...stat });
        setName(stat.name);
        setPutError("");
        setScreen("put");
      } catch (error) {
        if (alive.current && serial === sourceSerial.current)
          setPutError(errMessage(error));
      } finally {
        if (alive.current && serial === sourceSerial.current)
          setSelecting(false);
      }
    },
    [writesLocked, tr, clearSecrets],
  );
  async function chooseLocal() {
    if (selectingGuard.current || putPending || writesLocked) return;
    if (mobile) {
      fileRef.current?.click();
      return;
    }
    selectingGuard.current = true;
    try {
      const selected = await open({ multiple: false, directory: false });
      if (typeof selected === "string" && selected) await selectPath(selected);
    } catch (error) {
      if (alive.current) setPutError(errMessage(error));
    } finally {
      selectingGuard.current = false;
    }
  }
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (
          event.payload.type !== "drop" ||
          !["home", "put"].includes(screenRef.current) ||
          putGuard.current
        )
          return;
        if (event.payload.paths.length !== 1) {
          setPutError(tr("onlyOne"));
          setScreen("put");
          return;
        }
        void selectPath(event.payload.paths[0]);
      })
      .then((fn) => {
        if (disposed) fn();
        else stop = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [selectPath, tr]);
  async function chooseVault() {
    if (putPending || writesLocked) return;
    setVaultOpen(true);
    setVaultLoading(true);
    setVaultError("");
    try {
      const result = await api.fileList();
      if (alive.current) setVaultEntries(result.entries);
    } catch (error) {
      if (alive.current) setVaultError(errMessage(error));
    } finally {
      if (alive.current) setVaultLoading(false);
    }
  }
  const selectVault = useCallback(
    (entry: FileEntry, attachmentId: string) => {
      if (putPendingRef.current) return;
      const attachment = entryAttachments(entry).find(
        (item) => item.id === attachmentId,
      );
      if (!attachment) return;
      if (attachment.size > LOCKER_FILE_LIMIT) {
        setVaultError(tr("tooBig"));
        return;
      }
      sourceSerial.current++;
      setPutOperation(null);
      setPutResult(null);
      clearSecrets();
      setChosen({
        kind: "vault",
        entryId: entry.id,
        attachmentId,
        name: attachment.originalName,
        size: attachment.size,
      });
      setName(attachment.originalName || entry.name);
      setVaultOpen(false);
      setPutError("");
      setScreen("put");
    },
    [tr, clearSecrets],
  );
  useEffect(() => {
    const entryId = initialVault?.entryId || params.get("vault"),
      attachmentId = initialVault?.attId || params.get("att");
    if (!entryId) return;
    let cancelled = false;
    void api
      .fileList()
      .then((list) => {
        if (cancelled || !alive.current) return;
        setVaultEntries(list.entries);
        const entry = list.entries.find((item) => item.id === entryId);
        if (!entry) return;
        const files = entryAttachments(entry);
        if (attachmentId || files.length === 1)
          selectVault(entry, attachmentId || files[0].id);
        else {
          setVaultOpen(true);
          setScreen("put");
        }
      })
      .catch((error) => {
        if (!cancelled && alive.current) setPutError(errMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [initialVault?.entryId, initialVault?.attId, params, selectVault]);

  async function makeShare(id: string) {
    if (shareGuard.current || !serviceReady || writesLocked) return;
    shareGuard.current = true;
    setShareBusy(true);
    setDetailError("");
    const serial = secretSerial.current;
    try {
      const result = await withAuth((password) =>
        api.lockerShare(id, password),
      );
      if (!result || !alive.current) return;
      if (
        serial === secretSerial.current &&
        ["put", "detail"].includes(screenRef.current)
      ) {
        setShareUrl(result.url);
        setShareForId(id);
      }
      setPutResult((previous) =>
        previous?.id === id
          ? { ...previous, shared: true, shareError: "" }
          : previous,
      );
      await reload();
    } catch (error) {
      if (alive.current) {
        const message = errMessage(error);
        setDetailError(message);
        setPutResult((previous) =>
          previous?.id === id ? { ...previous, shareError: message } : previous,
        );
      }
    } finally {
      shareGuard.current = false;
      if (alive.current) setShareBusy(false);
    }
  }
  async function recoverPut(operation: LockerOperation) {
    if (!operation.itemId || operation.status !== "completed") return;
    const serial = secretSerial.current;
    const result = await withAuth((password) =>
      api.lockerRevealCode(operation.itemId!, password),
    );
    if (alive.current && result && serial === secretSerial.current)
      setPutResult({
        id: operation.itemId,
        code: result.code,
        name: operation.name || "",
        shared: false,
        shareError: "",
        operationId: operation.operationId,
      });
  }
  async function startPut() {
    if (putGuard.current || putPending || writesLocked) return;
    setPutError("");
    if (!chosen) {
      setPutError(tr("fileRequired"));
      return;
    }
    if (!name.trim()) {
      setPutError(tr("nameRequired"));
      return;
    }
    if (!rules.ok) {
      setPutError(
        tr(rules.field === "hours" ? "invalidHours" : "invalidPulls"),
      );
      return;
    }
    if (!canPut) {
      setPutError(tr(storageReady ? "serviceNeeded" : "storageNeeded"));
      return;
    }
    putGuard.current = true;
    setPutBusy(true);
    const operationId = putGateId.current || crypto.randomUUID(),
      selected = chosen,
      wantShare = sharePurpose,
      serial = secretSerial.current;
    const opts: LockerPutOptions = {
      operationId,
      shareRequested: wantShare,
      name: name.trim(),
      ttlSecs: rules.ttlSecs,
      permanent: rules.permanent,
      maxPulls: rules.maxPulls,
      unlimitedPulls: rules.unlimitedPulls,
    };
    setPutOperation({
      ...unknownOperation(operationId, "put", ""),
      status: "running",
      phase: "preparing",
      name: opts.name,
    });
    try {
      const result =
        selected.kind === "path"
          ? await lockerApi.putPath(selected.path, opts)
          : selected.kind === "file"
            ? await lockerApi.putBytes(
                selected.name,
                Array.from(new Uint8Array(await selected.file.arrayBuffer())),
                opts,
              )
            : await withAuth((password) =>
                lockerApi.putVault(
                  selected.entryId,
                  selected.attachmentId,
                  opts,
                  password,
                ),
              );
      if (!alive.current) return;
      if (!result) {
        setPutOperation(null);
        return;
      }
      setPutResult({
        id: result.id,
        code: serial === secretSerial.current ? result.code : "",
        name: opts.name || selected.name,
        shared: false,
        shareError: "",
        operationId,
      });
      setPutOperation({
        ...unknownOperation(operationId, "put", ""),
        status: "completed",
        phase: "completed",
        itemId: result.id,
        name: opts.name,
      });
      await reload();
      if (wantShare && alive.current) await makeShare(result.id);
    } catch (error) {
      if (!alive.current) return;
      const message = errMessage(error);
      try {
        const status = await lockerApi.operationStatus(operationId);
        if (alive.current) {
          if (!status && definitivePreflightGate(error)) {
            putGateId.current = operationId;
            setPutOperation(null);
            setPutError(message);
            return;
          }
          putGateId.current = null;
          setPutOperation(
            status || unknownOperation(operationId, "put", message),
          );
          if (
            status?.status === "completed" &&
            status.itemId &&
            screenRef.current === "put"
          )
            await recoverPut(status);
        }
      } catch {
        if (alive.current)
          setPutOperation(unknownOperation(operationId, "put", message));
      }
    } finally {
      putGuard.current = false;
      if (alive.current) setPutBusy(false);
    }
  }
  useEffect(() => {
    const op = putBusy ? putOperation : receiveBusy ? receiveOperation : null;
    if (!op) return;
    let reading = false,
      disposed = false;
    const timer = window.setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await lockerApi.operationStatus(op.operationId);
        if (!disposed && alive.current && next) {
          if (op.kind === "put") setPutOperation(next);
          else setReceiveOperation(next);
        }
      } catch {
        /* Original operation remains the authority. */
      } finally {
        reading = false;
      }
    }, 1200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    putBusy,
    receiveBusy,
    putOperation?.operationId,
    receiveOperation?.operationId,
  ]);

  function invalidateLookup() {
    receiveGateId.current = null;
    requestSerial.current++;
    setLookup(null);
    setLookupBusy(false);
    setTakeError("");
  }
  function openTake() {
    clearSecrets();
    setReceiveType("own");
    setScreen("take");
    setTakeError("");
  }
  function resetTake() {
    if (receivePending) return;
    setReceiveOperation(null);
    invalidateLookup();
    clearSecrets();
  }
  async function lookupFile(sourceOverride?: LockerSource) {
    if (receivePending || writesLocked) return;
    const source: LockerSource =
      sourceOverride ||
      (receiveType === "share"
        ? { shareUrl: externalLink.trim(), code: normalizeLockerCode(code) }
        : { code: normalizeLockerCode(code) });
    if (!source.id && !isLockerCode(source.code || "")) {
      setTakeError(tr("invalidCode"));
      return;
    }
    if (source.shareUrl && !validLockerShareLink(source.shareUrl)) {
      setTakeError(tr("invalidLink"));
      return;
    }
    if (!source.id && receiveType === "share" && !source.shareUrl) {
      setTakeError(tr("invalidLink"));
      return;
    }
    const serial = ++requestSerial.current;
    setLookupBusy(true);
    setLookup(null);
    setTakeError("");
    try {
      const info = await withAuth((password) =>
        lockerApi.lookup(source, password),
      );
      if (alive.current && serial === requestSerial.current && info)
        setLookup({ info, source });
    } catch (error) {
      if (alive.current && serial === requestSerial.current)
        setTakeError(errMessage(error));
    } finally {
      if (alive.current && serial === requestSerial.current)
        setLookupBusy(false);
    }
  }
  function takeItem(id: string) {
    clearSecrets();
    setReceiveType("own");
    setScreen("take");
    void lookupFile({ id });
  }
  async function receive() {
    if (receiveGuard.current || !lookup || receivePending || writesLocked)
      return;
    receiveGuard.current = true;
    setReceiveBusy(true);
    setTakeError("");
    const snapshot = lookup,
      serial = requestSerial.current,
      destinationKind = target;
    let operationId: string | undefined;
    try {
      let path: string | undefined;
      if (destinationKind === "disk") {
        const selected = await save({
          defaultPath: snapshot.info.originalName || snapshot.info.name,
        });
        if (!selected) return;
        path = selected;
      }
      if (!alive.current || serial !== requestSerial.current) return;
      operationId = receiveGateId.current || crypto.randomUUID();
      setReceiveOperation({
        ...unknownOperation(operationId, "receive", ""),
        status: "running",
        phase: "preparing",
        name: snapshot.info.name,
      });
      const result = await withAuth((password) =>
        lockerApi.receive(
          {
            operationId: operationId!,
            source: snapshot.source,
            snapshotVersion: snapshot.info.version,
            destination: { kind: destinationKind, path },
          },
          password,
        ),
      );
      if (!alive.current) return;
      if (!result) {
        setReceiveOperation(null);
        return;
      }
      setReceiveOperation(result);
      await reload();
    } catch (error) {
      if (!alive.current) return;
      const message = errMessage(error);
      if (!operationId) setTakeError(message);
      else {
        try {
          const op = await lockerApi.operationStatus(operationId);
          if (alive.current) {
            if (!op && definitivePreflightGate(error)) {
              receiveGateId.current = operationId;
              setReceiveOperation(null);
              setTakeError(message);
              return;
            }
            receiveGateId.current = null;
            setReceiveOperation(
              op || unknownOperation(operationId, "receive", message),
            );
          }
        } catch {
          if (alive.current)
            setReceiveOperation(
              unknownOperation(operationId, "receive", message),
            );
        }
      }
    } finally {
      receiveGuard.current = false;
      if (alive.current) setReceiveBusy(false);
    }
  }
  async function checkOperation(operation: LockerOperation, resume = false) {
    if (operationGuard.current || (resume && writesLocked)) return;
    operationGuard.current = true;
    setOperationBusy(operation.operationId);
    try {
      const known = await lockerApi.operationStatus(operation.operationId);
      if (!known) {
        if (alive.current) setToast(tr("operationMissing"));
        return;
      }
      const next =
        resume && known.recoverable
          ? await withAuth((password) =>
              lockerApi.operationResume(known.operationId, password),
            )
          : known;
      if (!alive.current || !next) return;
      if (next.kind === "put") {
        setPutOperation(next);
        setScreen("put");
        if (next.status === "completed") await recoverPut(next);
      } else {
        setReceiveOperation(next);
        setScreen("take");
      }
      await reload();
    } catch (error) {
      if (alive.current) setToast(errMessage(error));
    } finally {
      operationGuard.current = false;
      if (alive.current) setOperationBusy("");
    }
  }
  async function retargetOperation(operation: LockerOperation) {
    if (!operation.canRetarget || operationGuard.current || writesLocked)
      return;
    operationGuard.current = true;
    setOperationBusy(operation.operationId);
    try {
      const path = await save({
        defaultPath: lockerFilename(operation.name || "file"),
      });
      if (!path || !alive.current) return;
      const next = await withAuth((password) =>
        lockerApi.operationRetarget(
          operation.operationId,
          { kind: "disk", path },
          password,
        ),
      );
      if (next && alive.current) {
        setReceiveOperation(next);
        setScreen("take");
        await reload();
      }
    } catch (error) {
      if (alive.current) setToast(errMessage(error));
    } finally {
      operationGuard.current = false;
      if (alive.current) setOperationBusy("");
    }
  }
  function openDetail(item: LockerItem) {
    clearSecrets();
    setDetailId(item.id);
    setDetailError("");
    setScreen("detail");
  }
  async function showCode(id: string) {
    if (detailGuard.current) return;
    const serial = secretSerial.current;
    detailGuard.current = true;
    setDetailBusy(true);
    try {
      const result = await withAuth((password) =>
        api.lockerRevealCode(id, password),
      );
      if (alive.current && result && serial === secretSerial.current) {
        setDetailCode(result.code);
        setPutResult((previous) =>
          previous?.id === id ? { ...previous, code: result.code } : previous,
        );
      }
    } catch (error) {
      if (alive.current) setDetailError(errMessage(error));
    } finally {
      detailGuard.current = false;
      if (alive.current) setDetailBusy(false);
    }
  }
  async function performConfirmed() {
    if (!confirm || detailGuard.current || writesLocked) return;
    const action = confirm;
    detailGuard.current = true;
    setDetailBusy(true);
    setDetailError("");
    try {
      if (action.kind === "history") {
        await lockerApi.clearHistory();
        if (alive.current) setToast(tr("historyCleared"));
      } else if (action.kind === "migrate") {
        const migrated = await withAuth(async (password) => {
          await lockerApi.migrateLegacy(action.item.id, password);
          return true;
        });
        if (!migrated) return;
        if (alive.current) {
          clearSecrets();
          setToast(tr("migrationDone"));
        }
      } else if (action.kind === "stop") {
        await api.lockerRevokeShare(action.item.id);
        if (alive.current) {
          setShareUrl("");
          setShareForId("");
          setToast(tr("shareStopped"));
        }
      } else {
        await api.lockerDelete(action.item.id);
        if (alive.current) {
          clearSecrets();
          setToast(tr("deleteRequested"));
        }
      }
      if (alive.current) {
        setConfirm(null);
        await reload();
      }
    } catch (error) {
      if (alive.current) {
        setDetailError(errMessage(error));
        setToast(errMessage(error));
        setConfirm(null);
      }
    } finally {
      detailGuard.current = false;
      if (alive.current) setDetailBusy(false);
    }
  }
  async function copy(value: string) {
    try {
      await copyWithClear(value, undefined, true);
      if (alive.current) setToast(tr("copied"));
    } catch (error) {
      if (alive.current) setToast(errMessage(error));
    }
  }
  function expiry(item: { expireAt?: string | null }) {
    if (!item.expireAt) return tr("forever");
    const left = Date.parse(item.expireAt) - tick;
    if (!Number.isFinite(left)) return "—";
    if (left <= 0) return tr("expired");
    if (left >= 86400000)
      return tr("daysLeft", { count: Math.ceil(left / 86400000) });
    if (left >= 3600000)
      return tr("hoursLeft", { count: Math.ceil(left / 3600000) });
    return tr("minutesLeft", { count: Math.max(1, Math.ceil(left / 60000)) });
  }
  function statusLabel(item: LockerItem) {
    if (item.cleanupStatus === "cleaned") return tr("cleaned");
    if (item.syncStatus === "unknown" && !lockerAccessEnded(item, tick))
      return tr("statusUnknown");
    if (
      item.inFlightClaims &&
      !lockerAccessEnded(item, tick) &&
      item.pullsLeft === 0
    )
      return tr("inFlight");
    if (!lockerAccessEnded(item, tick) && item.shareStatus === "failed")
      return tr("shareFailed");
    if (!lockerAccessEnded(item, tick) && item.shareStatus === "pending")
      return tr("sharePending");
    const state =
      item.accessStatus === "deleted"
        ? tr("deleted")
        : item.accessStatus === "exhausted"
          ? tr("exhausted")
          : lockerAccessEnded(item, tick)
            ? tr("expired")
            : item.pullsLeft === 0 && !!item.inFlightClaims
              ? tr("inFlight")
              : item.share || item.shareStatus === "active"
                ? tr("shareEnabled")
                : tr("available");
    return item.cleanupStatus === "pending"
      ? `${state} · ${tr("cleanupPending")}`
      : item.cleanupStatus === "failed"
        ? `${state} · ${tr("cleanupFailed")}`
        : state;
  }
  function quota(item: {
    maxPulls?: number | null;
    pullsLeft?: number | null;
  }) {
    return item.maxPulls == null
      ? tr("unlimited")
      : tr("leftOfTotal", {
          left: item.pullsLeft ?? "—",
          total: item.maxPulls,
        });
  }
  function phaseLabel(phase: string) {
    const map: Record<string, string> = {
      preparing: "phasePreparing",
      prepared: "phasePreparing",
      encrypting: "phaseEncrypting",
      uploading: "phaseUploading",
      registering: "phaseRegistering",
      downloading: "phaseDownloading",
      decrypting: "phaseDecrypting",
      saving: "phaseSaving",
      acknowledging: "phaseAcknowledging",
      ack: "phaseAcknowledging",
    };
    return map[phase] ? tr(map[phase]) : tr("working");
  }
  return {
    t,
    tr,
    i18n,
    navigate,
    writesLocked,
    screen,
    setScreen,
    items,
    loading,
    listError,
    connection,
    connectionError,
    checking,
    filter,
    setFilter,
    search,
    setSearch,
    tick,
    chosen,
    selecting,
    name,
    setName,
    ttl,
    setTtl,
    hours,
    setHours,
    pulls,
    setPulls,
    customPulls,
    setCustomPulls,
    sharePurpose,
    setSharePurpose,
    advanced,
    setAdvanced,
    putError,
    setPutError,
    putOperation,
    putResult,
    putBusy,
    shareBusy,
    shareUrl,
    shareForId,
    receiveType,
    setReceiveType,
    code,
    setCode,
    externalLink,
    setExternalLink,
    lookup,
    lookupBusy,
    takeError,
    target,
    setTarget,
    receiveBusy,
    receiveOperation,
    operations,
    operationBusy,
    detail,
    detailCode,
    detailError,
    detailBusy,
    confirm,
    setConfirm,
    toast,
    setToast,
    vaultOpen,
    setVaultOpen,
    vaultEntries,
    vaultLoading,
    vaultError,
    reauth,
    reauthCancel,
    fileRef,
    serviceReady,
    storageReady,
    rules,
    canPut,
    putPending,
    receivePending,
    filtered,
    shareSvg,
    reload,
    onConfigChanged,
    goHome,
    clearSecrets,
    checkConnections,
    openPut,
    resetPut,
    removeChosen,
    selectFile,
    chooseLocal,
    chooseVault,
    selectVault,
    makeShare,
    startPut,
    invalidateLookup,
    openTake,
    resetTake,
    lookupFile,
    takeItem,
    receive,
    checkOperation,
    retargetOperation,
    openDetail,
    showCode,
    performConfirmed,
    copy,
    expiry,
    statusLabel,
    quota,
    phaseLabel,
  };
}
export type LockerWorkbenchModel = ReturnType<typeof useLockerWorkbench>;
