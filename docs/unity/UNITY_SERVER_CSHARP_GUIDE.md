# Unity ↔ Server C# Integration Guide (.NET Framework)

이 문서는 **Unity 클라이언트 개발자**가 서버 API와 통신할 때 사용할 **C# (.NET Framework) 코드 예시**와 **통신 가이드**를 제공합니다.

> ✅ Unity에서 `HttpClient`를 사용할 경우 **Unity 2021+ / .NET 4.x** 환경을 권장합니다.
> ✅ 모든 요청은 **HTTPS**로 호출해야 하며, WebSocket은 **WSS**만 허용됩니다.

---

## 1) 프로젝트 전제

- Unity Player Settings → **Api Compatibility Level: .NET 4.x**
- Scripting Runtime: **.NET 4.x Equivalent**
- HTTPS 사용 필수

---

## 2) C# API 클라이언트 코드 (Unity용)

아래 코드는 Unity에서 그대로 사용할 수 있는 **간단한 API 클라이언트**입니다.

### ✅ 파일 1: `EnochServerClient.cs`

```csharp
using System;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;

public class EnochServerClient
{
    private readonly HttpClient _client;
    private readonly string _baseUrl;

    public EnochServerClient(string baseUrl)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _client = new HttpClient();
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, string path, string walletAddress = null, object body = null)
    {
        var req = new HttpRequestMessage(method, _baseUrl + path);
        if (!string.IsNullOrEmpty(walletAddress))
        {
            req.Headers.Add("x-wallet-address", walletAddress);
        }
        if (body != null)
        {
            string json = JsonConvert.SerializeObject(body);
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }
        return req;
    }

    public async Task<UserResponse> WalletLogin(string walletAddress)
    {
        var req = CreateRequest(HttpMethod.Post, "/auth/wallet-login", null,
            new { walletAddress = walletAddress });
        var res = await _client.SendAsync(req);
        return await ReadJson<UserResponse>(res);
    }

    public async Task<UserResponse> GetMe(string walletAddress)
    {
        var req = CreateRequest(HttpMethod.Get, "/me", walletAddress);
        var res = await _client.SendAsync(req);
        return await ReadJson<UserResponse>(res);
    }

    public async Task<RunStartResponse> StartRun(string walletAddress, int creditsWagered)
    {
        var req = CreateRequest(HttpMethod.Post, "/runs/start", walletAddress,
            new { creditsWagered = creditsWagered });
        var res = await _client.SendAsync(req);
        return await ReadJson<RunStartResponse>(res);
    }

    public async Task<RunFinishResponse> FinishRun(string walletAddress, RunFinishRequest body)
    {
        var req = CreateRequest(HttpMethod.Post, "/runs/finish", walletAddress, body);
        var res = await _client.SendAsync(req);
        return await ReadJson<RunFinishResponse>(res);
    }

    public async Task<RunAbortResponse> AbortRun(string walletAddress, string runId)
    {
        var req = CreateRequest(HttpMethod.Post, "/runs/abort", walletAddress,
            new { runId = runId });
        var res = await _client.SendAsync(req);
        return await ReadJson<RunAbortResponse>(res);
    }

    public async Task<LeaderboardScoreResponse> GetScoreLeaderboard()
    {
        var req = CreateRequest(HttpMethod.Get, "/leaderboards/score");
        var res = await _client.SendAsync(req);
        return await ReadJson<LeaderboardScoreResponse>(res);
    }

    public async Task<LeaderboardTicketsResponse> GetTicketsLeaderboard()
    {
        var req = CreateRequest(HttpMethod.Get, "/leaderboards/tickets");
        var res = await _client.SendAsync(req);
        return await ReadJson<LeaderboardTicketsResponse>(res);
    }

    public async Task<SkinsAvailableResponse> GetSkins(string walletAddress)
    {
        var req = CreateRequest(HttpMethod.Get, "/skins/available", walletAddress);
        var res = await _client.SendAsync(req);
        return await ReadJson<SkinsAvailableResponse>(res);
    }

    public async Task<StatusResponse> RefreshSkins(string walletAddress)
    {
        var req = CreateRequest(HttpMethod.Post, "/skins/refresh", walletAddress);
        var res = await _client.SendAsync(req);
        return await ReadJson<StatusResponse>(res);
    }

    public async Task<StatusResponse> EquipSkin(string walletAddress, int skinId, string skinType)
    {
        var req = CreateRequest(HttpMethod.Post, "/skins/equip", walletAddress,
            new { skinId = skinId, skinType = skinType });
        var res = await _client.SendAsync(req);
        return await ReadJson<StatusResponse>(res);
    }

    private async Task<T> ReadJson<T>(HttpResponseMessage res)
    {
        string json = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
        {
            throw new Exception("Server error: " + json);
        }
        return JsonConvert.DeserializeObject<T>(json);
    }
}
```

---

## 3) DTO 모델

### ✅ 파일 2: `ServerModels.cs`

```csharp
using System;
using System.Collections.Generic;

[Serializable]
public class UserResponse
{
    public User user;
}

[Serializable]
public class User
{
    public int id;
    public string wallet_address;
    public int credit_balance;
    public int raffle_tickets_total;
    public int equipped_note_skin_id;
    public int equipped_gear_skin_id;
}

[Serializable]
public class RunStartResponse
{
    public string runId;
    public int multiplierLocked;
    public string runNonce;
}

[Serializable]
public class RunFinishRequest
{
    public string runId;
    public int rawScore;
    public string runNonce;
    public string checksum;
    public bool cleared;
    public string difficulty; // easy | normal | hard | extreme
}

[Serializable]
public class RunFinishResponse
{
    public string runId;
    public int rawScore;
    public int ticketsEarned;
    public string status;
}

[Serializable]
public class RunAbortResponse
{
    public string runId;
    public string status;
    public int refundedCredits; // 현재 항상 0
}

[Serializable]
public class LeaderboardScoreResponse
{
    public List<ScoreEntry> leaderboard;
}

[Serializable]
public class ScoreEntry
{
    public string wallet_address;
    public int raw_score;
}

[Serializable]
public class LeaderboardTicketsResponse
{
    public List<TicketEntry> leaderboard;
}

[Serializable]
public class TicketEntry
{
    public string wallet_address;
    public int raffle_tickets_total;
}

[Serializable]
public class SkinsAvailableResponse
{
    public List<Skin> skins;
    public List<int> unlockedSkinIds;
    public int equipped_note_skin_id;
    public int equipped_gear_skin_id;
}

[Serializable]
public class Skin
{
    public int skin_id;
    public string skin_type;
    public string display_name;
    public string asset_ref;
}

[Serializable]
public class StatusResponse
{
    public string status;
}
```

---

## 4) 체크섬(HMAC) 계산

`/runs/finish` 호출 시 `checksum`이 필요합니다.

### ✅ 계산 규칙
```
checksum = HMAC_SHA256("runId:rawScore:runNonce", RUN_CHECKSUM_SECRET)
```

### ✅ C# 예시

```csharp
using System.Security.Cryptography;
using System.Text;

public static string BuildRunChecksum(string runId, int rawScore, string runNonce, string secret)
{
    string payload = $"{runId}:{rawScore}:{runNonce}";
    using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret)))
    {
        byte[] hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(payload));
        var sb = new StringBuilder();
        foreach (byte b in hash)
        {
            sb.Append(b.ToString("x2"));
        }
        return sb.ToString();
    }
}
```

> ⚠️ `RUN_CHECKSUM_SECRET`는 서버에서 관리되는 값이며, **클라이언트에 직접 노출하지 않는 것을 권장**합니다. 이 값은 Unity 클라이언트가 아니라 **서버에서 체크섬을 생성**하는 방식으로 전환할 수도 있습니다.

---

## 5) Unity 사용 예시

```csharp
public async void ExampleFlow()
{
    var client = new EnochServerClient("https://api.yourdomain.com");

    // 로그인
    var login = await client.WalletLogin("0xabc...");

    // 게임 시작
    var run = await client.StartRun("0xabc...", 2);

    // 체크섬 생성
    string checksum = BuildRunChecksum(run.runId, 12345, run.runNonce, "RUN_CHECKSUM_SECRET");

    // 게임 종료
    var result = await client.FinishRun("0xabc...", new RunFinishRequest {
        runId = run.runId,
        rawScore = 12345,
        runNonce = run.runNonce,
        checksum = checksum,
        cleared = true,
        difficulty = "normal"
    });
}
```

---

## 6) 주의 사항 요약

- `x-wallet-address`가 없으면 대부분의 쓰기 API는 실패합니다.
- `runs/finish`는 반드시 `runNonce`와 `checksum`이 필요합니다.
- 티켓 보상은 `credits_wagered * difficulty_weight`로 계산됩니다.
- `/runs/abort`는 **크레딧 환불이 없습니다**.

---

## 7) 실시간 랭킹 (InGame/Result Scene)

실시간 랭킹은 **WebSocket(WSS)** 연결을 통해 수신합니다.

### ✅ 구독 요청
클라이언트가 아래 JSON을 WebSocket으로 전송하면 서버가 랭킹 업데이트를 push합니다.

```json
{ "type": "subscribe_leaderboards" }
```

### ✅ 서버 푸시 메시지 형식

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

### ✅ Unity C# 예시 (ClientWebSocket)

```csharp
using System;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;

public async Task SubscribeLeaderboards(string wssUrl)
{
    using (var ws = new ClientWebSocket())
    {
        await ws.ConnectAsync(new Uri(wssUrl), CancellationToken.None);
        var subscribe = Encoding.UTF8.GetBytes(\"{\\\"type\\\":\\\"subscribe_leaderboards\\\"}\");
        await ws.SendAsync(new ArraySegment<byte>(subscribe), WebSocketMessageType.Text, true, CancellationToken.None);

        var buffer = new byte[8192];
        while (ws.State == WebSocketState.Open)
        {
            var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), CancellationToken.None);
            if (result.MessageType == WebSocketMessageType.Close) break;
            var json = Encoding.UTF8.GetString(buffer, 0, result.Count);
            // json = leaderboard_update payload
        }
    }
}
```

> InGame Scene: 실시간 랭킹 상태 표시  
> Result Scene: 전체 플레이어 랭킹 표시 (동일 데이터 사용)

---

## 8) 제공 파일 요약

- `docs/unity/UNITY_SERVER_CSHARP_GUIDE.md`
- (Unity용) `EnochServerClient.cs`
- (Unity용) `ServerModels.cs`

필요하면 실제 Unity 프로젝트용 `.unitypackage` 형식으로도 준비 가능합니다.
