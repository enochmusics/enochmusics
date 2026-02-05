using System.Security.Cryptography;
using System.Text;

public static class RunChecksum
{
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
}
