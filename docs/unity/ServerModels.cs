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
