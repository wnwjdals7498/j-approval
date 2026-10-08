# 클라우드 실제 결재 백엔드 검증 — 2026-10-08

최신 `origin/main` `75498e318ef929d84a8ed8c8f339d9ea348800ba`의 문서 전용 상태에서 `codex/cloud-auth-foundation-20261008` 브랜치를 만들었다. j-auth 선행 구현은 `1a8c09e933ab6de6fc953592ddda8cd9015620b9`, j-groupware 실시간 선행은 `bff60ce9fff712bca527709f7b814b18919c82e2`다. 운영 자격·회사 노트북·OS hosts/CA는 바꾸지 않았다.

## 구현

A1의 서버/계약 workspace, dedicated PostgreSQL `jgw_approval` 비관리자 계정, checksum/advisory lock migration, HTTPS loopback startup/readiness/종료를 구현했다. A2의 DTO와 API/길이/페이지/단계/revision/오류 계약을 고정했다. `@j-approval/contracts@0.1.0`을 **클라우드 내부 loopback Verdaccio**에 게시하고 별도 소비자의 실제 exact-version 설치·integrity 일치를 확인했다. 공용 npm 배포는 하지 않았다.

A4는 기존 게시된 j-auth verifier로 실제 JWT/JWKS의 issuer·tenant·azp·단일 audience `j-approval`을 검증한다. 설치가 허용한 tenant와 인간 회원 sid/username을 검사하며 `approval:use`를 요구한다. API는 bearer만 받으며 cookie 인증·임의 tenant/작성자·다중 audience를 거절한다. role이 있어도 현재 결재선 지정자가 아니면 처리할 수 없다.

A5/A6는 문서/순서 있는 단계 스냅샷/append-only 이력, 내 작성·현재 차례·처리 문서 목록과 참가자 상세/이력, 1~32단계 검증, 순차 승인/최종 승인/사유 있는 반려를 구현했다. 문서 행 `FOR UPDATE`와 revision을 함께 사용한다. 같은 revision의 동시 승인·반려는 1건만 commit하며 다른 요청은 409다. 종결 업무 변경은 409지만 허용된 열람 이력은 추가한다. DB trigger는 원문·작성자·스냅샷과 단계/기존 이력 수정을 거절한다. 회원 존재/조직도 조회는 하지 않는다.

A9의 outbox 기록은 상태·단계·이력과 같은 트랜잭션이다. 상신/단계 이동은 다음 지정자 turn, 종결은 작성자 done이며 `문서id:단계:사건`의 tenant별 unique 키를 쓴다. 초기 확인은 outbox 기록만 포함했다. 후속 [실제 배달 검증](cloud-notification-delivery-2026-10-08.md)에서 송신 루프·G22 수신·실패 재시도를 구현하고 실제 실행했다. outbox 저장 성공을 알림 배달 성공으로 표시하지 않는다.

## 실행 결과

- `npm ci --ignore-scripts --offline`: private scope 포함 lockfile 설치 성공.
- `npm run check`: build·테스트 타입 검사·단위 **17/17**·lint·format 통과.
- `npm run test:integration`: 실제 의존성 **21/21**, 실패·skip 0. compiled 서버 정상 종료 exit 0와 restart 후 문서 보존 포함.
- `npm run test:registry`: 실제 exact-version 소비자 설치·integrity **1/1**, 실패·skip 0.

실제 j-auth API로 작성자/결재자 2명/외부 회원 4명을 만들고 삭제했다. Keycloak password grant와 token exchange로 발급한 single-audience token을 사용하며 fake 토큰/JWKS/DB/결재 서버로 대체하지 않았다. sample-a의 무권한 `a-member`와 sample-b의 `b-admin`도 실제 토큰을 발급했다. 두 tenant 서버/문서를 같은 전용 DB에서 검사했다.

1단계·N단계·최대 32단계 입력, 빈/중복/작성자/길이/임의 identity 거절, 이전/미래/외부 지정자 거절, 반려 사유, 최종 상태와 이력, 실제 51건 목록/51회 열람의 cursor 페이지를 확인했다. PostgreSQL trigger로 outbox 삽입을 실패시켜 상신 전체 또는 처리 상태·이력·outbox가 함께 rollback되고 원래 revision의 재시도가 성공하는지 확인했다. 실제 접속 불가 DB와 JWKS 네트워크 오류도 503과 업무 무변경을 확인했다.

원본은 체크아웃 밖 `/workspace/.suite-runtime/j-approval/check.log`, `integration-results.json`, `integration.log`, `registry-test.log`, `ci.log`다. 첫 compiled 시험은 부모 env의 port 상속을 발견해 명시적인 자식 env로 수정했고, cleanup의 이미 signal 종료된 프로세스 감지도 수정했다. 실패했던 실행을 통과로 계산하지 않았다.

## 미완료 경계

후속 [결재 BFF 검증](../../j-groupware/docs/cloud-approval-bff-verification-2026-10-08.md)에서 실제 조직도 변경 후 snapshot 보존을 확인했고, [배달 검증](cloud-notification-delivery-2026-10-08.md)에서 AP-T05의 G22 재송신/중복 수신을 확인했다. AP-T06의 고객 VM 설치/화면/해지와 전체 제품군 인수는 미실행이다. 정식 UI 기준/화면·Nginx/VM 배포가 별도 후속이다. 삭제/권한 회수된 결재자 처리 정책을 새로 정하거나 자동 대결·재지정을 만들지 않았다. `whole_suite_verified=false`를 유지한다. PR·main 병합·배포는 하지 않았다.
