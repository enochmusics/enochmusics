# 업데이트 로그 (2026-02-07)

## 요약
- **실시간 랭킹 (InGame/Result)**: WSS 구독 기반 실시간 리더보드 push 추가 (score/tickets 동시 전송).
- **서버 측 리더보드 공통화**: REST 응답과 실시간 payload를 같은 조회 로직으로 통일.
- **랭킹 갱신 트리거**: run 종료/관리자 티켓 조정/런 무효화 시 실시간 스냅샷 publish.
- **Unity 문서 갱신**: 실시간 랭킹 구독 메시지 및 수신 포맷 안내 추가.

## 상세 변경
### 1) 실시간 리더보드 (WSS)
- 클라이언트가 `{"type":"subscribe_leaderboards"}` 메시지를 보내면 서버가 실시간 랭킹 스냅샷을 push.
- 서버는 `leaderboards-realtime` Redis 채널에 스냅샷을 publish하여 다중 인스턴스에서도 동기화 가능.

### 2) REST/Realtime 공통화
- 리더보드 REST는 공통 fetcher를 재사용하여 실시간 payload와 동일한 기준으로 집계.

### 3) Publish 트리거
- `/runs/finish` 완료 시
- `/admin/tickets/adjust` 완료 시
- `/admin/runs/invalidate` 완료 시

## 클라이언트 영향
- InGame Scene, Result Scene 모두 **동일한 WSS 리더보드 스트림**을 사용하면 됩니다.
- 기존 REST 폴링을 유지해도 되지만, 실시간 표시에는 WSS가 권장됩니다.

