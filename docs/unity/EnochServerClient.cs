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
