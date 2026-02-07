# Unity ↔ Server API Guide

이 문서는 Unity(WebGL/클라이언트)에서 서버와 통신할 때 사용할 **API 목록**, **요청 파라미터**, **응답 결과**를 정리합니다.

> ✅ 모든 요청은 **HTTPS**로 호출해야 하며, WebSocket은 **WSS**만 허용됩니다.

---

## 공통 사항

### Base URL
- `https://<API_HOST>`

### 공통 헤더
- `Content-Type: application/json`
- `x-wallet-address: <user_wallet_address>`
  - 유저 지갑 주소를 서버 계정으로 매핑하는 데 사용됩니다.
  - Unity 클라이언트가 지갑을 직접 연결하지 않더라도, **호스트 웹에서 받은 지갑 주소를 전달**해야 합니다.

### 인증 방식
- 쓰기(상태 변경) API는 `x-wallet-address`가 필요합니다.
- 리더보드 읽기 API는 공개입니다.

---

## 1) 로그인 / 계정

### `POST /auth/wallet-login`
**목적:** 지갑 주소로 유저 계정을 생성/조회합니다.

**Request Body**
```json
{
  "walletAddress": "0xabc..."
}
```

**Response**
```json
{
  "user": {
    "id": 1,
    "wallet_address": "0xabc...",
    "credit_balance": 10,
    "raffle_tickets_total": 3,
    "equipped_note_skin_id": 1,
    "equipped_gear_skin_id": 100
  }
}
```

---

## 2) 내 정보 조회

### `GET /me`
**목적:** 현재 지갑에 매핑된 유저 정보를 조회합니다.

**Headers**
```
x-wallet-address: 0xabc...
```

**Response**
```json
{
  "user": {
    "id": 1,
    "wallet_address": "0xabc...",
    "credit_balance": 10,
    "raffle_tickets_total": 3,
    "equipped_note_skin_id": 1,
    "equipped_gear_skin_id": 100
  }
}
```

---

## 3) 크레딧 구매 (서버 지갑 사용)

### `POST /credits/create-order`
**목적:** 결제 주문을 생성하고 orderId를 발급받습니다.

**Headers**
```
x-wallet-address: 0xabc...
```

**Response**
```json
{
  "orderId": "<uuid>",
  "orderIdBytes32": "0x..."
}
```

### `POST /credits/buy`
**목적:** 서버 지갑으로 온체인 결제를 발생시킵니다.

**Headers**
```
x-wallet-address: <SERVER_WALLET_ADDRESS>
```

**Request Body**
```json
{
  "orderId": "<uuid>"
}
```

**Response**
```json
{
  "orderId": "<uuid>",
  "orderIdBytes32": "0x...",
  "txHash": "0x..."
}
```

### `GET /credits/order-status?orderId=<uuid>`
**목적:** 주문이 블록체인에서 확인되었는지 조회합니다.

**Response**
```json
{
  "orderId": "<uuid>",
  "status": "pending" | "confirmed" | "not_found"
}
```

---

## 4) 게임 시작

### `POST /runs/start`
**목적:** 게임 시작 시 크레딧을 차감하고 run을 생성합니다.

**Headers**
```
x-wallet-address: 0xabc...
```

**Request Body**
```json
{
  "creditsWagered": 2
}
```

**Response**
```json
{
  "runId": "<uuid>",
  "multiplierLocked": 1,
  "runNonce": "<random-hex>"
}
```

---

## 5) 게임 종료

### `POST /runs/finish`
**목적:** 게임 종료 시 점수/티켓을 확정합니다.

**Headers**
```
x-wallet-address: 0xabc...
```

**Request Body**
```json
{
  "runId": "<uuid>",
  "rawScore": 12345,
  "runNonce": "<random-hex>",
  "checksum": "<hmac-sha256>",
  "cleared": true,
  "difficulty": "easy" | "normal" | "hard" | "extreme"
}
```

**Response**
```json
{
  "runId": "<uuid>",
  "rawScore": 12345,
  "ticketsEarned": 4,
  "status": "finished"
}
```

**Notes**
- `checksum = HMAC_SHA256(runId:rawScore:runNonce, RUN_CHECKSUM_SECRET)`
- 티켓 계산: `credits_wagered * difficulty_weight` (클리어 실패 시 0)

---

## 6) 게임 중단

### `POST /runs/abort`
**목적:** 유저가 게임을 중단할 때 run을 종료합니다. (크레딧은 환불되지 않습니다.)

**Headers**
```
x-wallet-address: 0xabc...
```

**Request Body**
```json
{
  "runId": "<uuid>"
}
```

**Response**
```json
{
  "runId": "<uuid>",
  "status": "aborted",
  "refundedCredits": 0
}
```

---

## 7) 리더보드

### `GET /leaderboards/score`
**목적:** 실력 랭킹 (raw_score 기준) 조회

**Response**
```json
{
  "leaderboard": [
    { "wallet_address": "0x...", "raw_score": 12345 }
  ]
}
```

### `GET /leaderboards/tickets`
**목적:** 티켓 랭킹 (누적 티켓 기준) 조회

**Response**
```json
{
  "leaderboard": [
    { "wallet_address": "0x...", "raffle_tickets_total": 10 }
  ]
}
```

---

## 7-1) 실시간 랭킹 (WebSocket)

WebSocket(WSS) 연결 후 아래 메시지를 보내면 실시간 랭킹을 수신합니다.

**Subscribe Message**
```json
{ "type": "subscribe_leaderboards" }
```

**Server Push**
```json
{
  "type": "leaderboard_update",
  "payload": {
    "score": [
      { "wallet_address": "0x...", "raw_score": 12345 }
    ],
    "tickets": [
      { "wallet_address": "0x...", "raffle_tickets_total": 10 }
    ]
  }
}
```

---

## 8) 스킨

### `GET /skins/available`
**목적:** 유저가 보유/장착 가능한 스킨 목록 조회

**Headers**
```
x-wallet-address: 0xabc...
```

**Response**
```json
{
  "skins": [
    { "skin_id": 1, "skin_type": "note", "display_name": "Default Note", "asset_ref": "note/default" }
  ],
  "unlockedSkinIds": [1, 100],
  "equipped_note_skin_id": 1,
  "equipped_gear_skin_id": 100
}
```

### `POST /skins/refresh`
**목적:** NFT 소유 여부를 갱신하고 스킨 해금을 갱신합니다.

**Headers**
```
x-wallet-address: 0xabc...
```

**Response**
```json
{
  "status": "refreshed"
}
```

### `POST /skins/equip`
**목적:** 보유한 스킨을 장착합니다.

**Headers**
```
x-wallet-address: 0xabc...
```

**Request Body**
```json
{
  "skinId": 1,
  "skinType": "note" | "gear"
}
```

**Response**
```json
{
  "status": "equipped"
}
```

---

## 9) 운영자/관리자용 (Unity에서는 사용하지 않음)

### `POST /admin/credits/adjust`
### `POST /admin/tickets/adjust`
### `POST /admin/runs/invalidate`

관리자용 API이며 `x-admin-key`가 필요합니다.

---

## 상태 코드 요약
- `200 OK`: 정상 처리
- `400 Bad Request`: 파라미터 누락/검증 실패
- `401 Unauthorized`: `x-wallet-address` 누락
- `403 Forbidden`: 권한 없음
- `404 Not Found`: 대상 없음
- `409 Conflict`: 이미 진행 중인 run 존재
- `429 Too Many Requests`: rate limit 초과
- `500+`: 서버 오류

---

## Unity 측 권장 흐름 (예시)

1. **로그인**: `/auth/wallet-login`
2. **내 정보 조회**: `/me`
3. **게임 시작**: `/runs/start`
4. **게임 종료**: `/runs/finish`
5. **스킨 조회/장착**: `/skins/available` → `/skins/equip`
6. **리더보드 조회**: `/leaderboards/score` or `/leaderboards/tickets`
