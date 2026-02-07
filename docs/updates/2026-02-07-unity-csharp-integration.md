# Unity 연동 가이드 (C# / .NET Framework) — 2026-02-07

이 문서는 Unity 클라이언트 개발자가 **C#/.NET Framework 환경에서 서버와 연동**하는 방법을 간단히 정리한 배포용 가이드입니다.

---

## 1) 환경 설정
- **Unity Player Settings**
  - Api Compatibility Level: **.NET 4.x**
  - Scripting Runtime: **.NET 4.x Equivalent**
- **네트워크 보안**
  - 모든 API는 **HTTPS**로 호출
  - 실시간 통신은 **WSS(WebSocket Secure)** 사용

---

## 2) 필수 헤더
- `Content-Type: application/json`
- `x-wallet-address: <user_wallet_address>`
  - 서버 계정 매핑에 필수 (쓰기 API는 필수 헤더)

---

## 3) 핵심 API 흐름
### 1) 로그인
`POST /auth/wallet-login`

### 2) 유저 정보 조회
`GET /me`

### 3) 게임 시작
`POST /runs/start`

### 4) 게임 종료
`POST /runs/finish`
- `runNonce` + `checksum` 필요
- 티켓 계산: `credits_wagered * difficulty_weight`

### 5) 리더보드
- REST: `/leaderboards/score`, `/leaderboards/tickets`
- 실시간(WSS): `subscribe_leaderboards` 메시지 전송 후 push 수신

---

## 4) 체크섬(HMAC) 규칙
```
checksum = HMAC_SHA256("runId:rawScore:runNonce", RUN_CHECKSUM_SECRET)
```
> ⚠️ `RUN_CHECKSUM_SECRET`는 클라이언트에 노출하지 않는 것을 권장합니다. 필요 시 서버에서 생성하도록 전환 가능.

---

## 5) 실시간 랭킹 (InGame/Result)
### 구독 메시지
```json
{ "type": "subscribe_leaderboards" }
```

### 서버 푸시 포맷
```json
{
  "type": "leaderboard_update",
  "payload": {
    "score": [ { "wallet_address": "0x...", "raw_score": 12345 } ],
    "tickets": [ { "wallet_address": "0x...", "raffle_tickets_total": 10 } ]
  }
}
```

---

## 6) Unity용 C# 샘플 코드 위치
- `docs/unity/EnochServerClient.cs`
- `docs/unity/ServerModels.cs`
- `docs/unity/RunChecksum.cs`
- `docs/unity/UNITY_SERVER_CSHARP_GUIDE.md`

