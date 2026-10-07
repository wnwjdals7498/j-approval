# j-approval 설계 결정

j-approval 최소 구현에 필요한 설계 결정을 정리한다. 제품군 공통 기준은 `j-groupware/docs/architecture.md`를 따르고, 이 문서는 그 위에서 j-approval이 정한 내용만 적는다. 각 결정은 PMT project `f8bf6842-6cb3-4f35-8997-832291aeb5f4`에 같은 번호의 `결정 N` 레코드로 기록되어 있다.

결정일: 2026-10-07

## 0. 범위

- **범위:** 고객(tenant)과 하위 회원을 위한 내부 전자결재 백엔드 API다. 조직도 기반 결재선과 커스텀 결재선을 쓰고, 순차 N단계로 처리한다. 문서는 1종이다. 화면은 j-groupware 페이지로 만든다.
- **완료 기준(Work W1):**
  1. `approval:use`를 가진 하위 회원이 문서(제목·본문)를 상신한다. 결재선은 j-groupware 조직도에서 자동 산출되거나 작성자가 같은 tenant 계정으로 커스텀 지정한다.
  2. 결재선의 각 단계 지정자만 순서대로 승인·반려할 수 있다. 마지막 단계 승인 시 승인, 어느 단계든 반려 시 반려(사유 필수)로 종결된다.
  3. 문서 상태와 단계별 처리 이력을 작성자와 결재자가 조회한다.
  4. 다른 tenant의 문서·결재선·계정은 보이지 않고 처리할 수 없다.
- **배치:** 고객 VM(tenant plane) 안에서 동작한다. API는 VM 내부 포트로만 열고 j-groupware 서버가 호출한다.
- **architecture.md:** §1·§4·§5의 j-approval 서술은 2026-10-07 결정 1·2·4에 맞게 갱신되었다(R6 반영, j-groupware 결정 21).
- **2026-10-07 갱신:** j-groupware 결정 2·20·21·22에 따라 결정 4·5·6·8·9·10·11과 Item A2·A6·A8을 고쳤다(PMT supersede 대기). 요지는 세 가지다. 결재선은 j-groupware가 만들어 상신 요청에 담아 보내고, j-approval은 j-groupware를 호출하지 않는다. Bearer 전달은 최소 구현의 최종 방식이다. 서비스 가입 모델을 따른다.

## 1. 서비스 대상과 형태

### 결정 1. 서비스 대상
- **결정:** j-approval은 가입한 고객(tenant)과 그 하위 회원을 위한 내부 전자결재다. 하위 회원이 올린 문서를 고객 쪽 결재선이 처리(전결)한다. 고객의 고객(손님)은 관계없고 j-customer-auth-db에 의존하지 않는다.
- **이유:** 사용자 지시.

### 결정 2. 서비스 형태와 화면 위치
- **결정:** j-approval은 백엔드 API 서비스(`apps/server`, `packages/contracts`)만 만든다. 결재 화면(상신·결재선 확인/커스텀·내 문서·결재함·상태/이력)은 j-groupware 페이지로 만든다. API는 고객 VM 내부 포트로만 열고 gateway로 외부에 노출하지 않는다.
- **이유:** 사용자 지시. j-customer-auth-db 결정 3과 같은 구성이고, 내부 포트만 여는 것은 architecture.md §2 중계 원칙을 따른다.

## 2. 결재선

### 결정 3. 결재자 기준
- **결정:** 결재선 각 단계에 지정된 사람만 그 단계를 처리한다. 지정자는 조직도에서 자동 산출되거나 작성자가 커스텀으로 고른 특정 계정이다. role은 결재 처리 자격이 아니라 메뉴·편집 같은 기능 권한만 뜻한다.
- **이유:** 조직도 기반 결재선(결정 4)과 맞춘다. 처음 답한 "결재 권한 보유자 누구나"는 이 결정으로 대체했다.

### 결정 4. 결재선과 최소 범위
- **결정:**
  - 회사 조직도로 기본 결재선을 자동 산출하고, 작성자가 커스텀 결재선(추가·삭제·순서 변경)을 지정할 수 있다.
  - **2026-10-07 갱신 (사용자 결정): 결재선 산출과 편집은 j-groupware가 한다.**
    - 산출 규칙은 소속 부서장 → 상위 부서장이고, 작성자 본인은 뺀다(j-groupware 결정 21, G15).
    - j-groupware는 상신 요청 본문에 결재선(단계 순서대로 j-auth 회원 id)을 담아 보낸다.
  - j-approval은 받은 결재선을 검증하고 스냅샷으로 저장한다. 검증 규칙은 세 가지다: 1단계 이상, 같은 회원 중복 없음, 작성자 본인 제외. 이후 조직도가 바뀌어도 진행 중인 문서는 영향을 받지 않는다.
  - 처리는 순차 N단계다. 문서는 1종이다.
  - 합의·병렬·참조는 backlog다.
- **이유:** 사용자 지시("조직도에 맞는 결재선, 커스텀 결재선"). architecture.md의 "결재 1단계"는 R6으로 갱신한다.

### 결정 5. 조직도 위치
- **결정:** 조직도(부서 트리·직책·소속, j-auth 회원 id 연결)는 j-groupware DB에 둔다. j-groupware가 편집 화면을 제공하고 결재선을 산출한다(결정 4). j-approval은 조직도를 저장하지도 조회하지도 않고, 상신 요청으로 받은 결재선 스냅샷만 저장한다. 편집 권한은 `org:manage`(결정 9)다.
- **2026-10-07 갱신:** 이전 내용은 "j-groupware가 조직도 조회 API를 제공하고 j-approval이 상신 시점에 조회한다"였다. 이 방식을 없애 서비스 호출을 한 방향(j-groupware → j-approval)으로 만들었다.
- **이유:** 조직도는 제품군 공용 자산이다.

### 결정 6. 결재 참여자 범위
- **결정:** 결재선에는 같은 tenant의 j-auth 고객 realm 계정(고객 관리자, 하위 회원)만 넣을 수 있다. 외부인·손님은 제외한다.
- **2026-10-07 갱신 (사용자 결정):** 커스텀 결재선의 후보는 j-groupware 조직도에 등록된 계정("미배치" 포함)으로 제한한다. j-groupware는 회원을 추가할 때 미배치에 자동 등록하고, 관리자는 기존 회원을 조직도에 추가한다. 이전 내용은 "조직도에 없는 같은 tenant 계정도 넣을 수 있다"였다.
  - j-approval은 결재선 회원 id가 실제로 같은 tenant 계정인지 따로 조회하지 않는다. 처리 요청의 토큰 `sub`·`tenant` claim이 스냅샷의 지정자와 일치해야만 처리되므로, 잘못된 id가 들어가도 다른 tenant 계정은 처리할 수 없다. 이런 문서는 진행되지 않을 뿐이다.

### 결정 7. 문서·상태 모델
- **결정:**
  - 문서는 1종(제목·본문)이다.
  - 상신하면 진행중이 된다. 현재 단계 지정자가 승인하면 다음 단계로 넘어간다.
  - 마지막 단계 승인 시 승인, 어느 단계든 반려 시 반려로 종결한다. 반려 사유는 필수다.
  - 종결 후에는 변경할 수 없다.
  - 이력은 append-only(상신·열람·승인·반려, 행위자·단계·시각)다.

## 3. 인증과 권한

### 결정 8. API 호출 인증
- **결정:**
  - j-groupware 서버는 회원 세션의 j-auth access token을 Bearer로 붙여 j-approval API를 호출한다.
  - j-approval은 j-auth 결정 19 기준(RS256, iss, `azp=j-auth`, aud에 `j-approval`, `tenant` claim, 허용 tenant)으로 검증한다. `approval:use` 보유와 결재선 지정 여부는 직접 검사한다. tenant는 토큰 claim에서만 정한다.
  - 2026-10-07: j-groupware 결정 2에 따라 Bearer 전달 + j-groupware 측 갱신을 최소 구현의 최종 방식으로 확정했다. backlog `55de09fb…`는 해소되었다. "세션 기반 관리로 전환"(사용자 지시)은 j-groupware의 OIDC 전환 backlog에 합쳐 함께 다룬다.
- **이유:** j-customer-auth-db 결정 5와 같은 방식이다.

### 결정 9. 기능 권한
- **결정:**
  - 고객 realm role 전용 client `j-approval`에 `approval:use`(결재 메뉴·상신·내 문서·결재함)를 둔다. 이 client와 role, aud는 j-approval에 가입한 고객 realm에만 있다(j-auth 결정 25).
  - 조직도 편집 권한 `org:manage`는 client `j-groupware`에 둔다(j-auth 결정 16 방식).
  - `tenant:admin` 묶음에 둘 다 포함하고, j-auth 회원 관리 API 부여 가능 role에 추가한다.
  - `j-auth` client audience mapper와 contracts aud 상수에 `j-approval`을 추가한다(j-auth 결정 19).
- **이유:** 결재 처리 자격은 결재선(결정 3)으로 정해지므로 role은 메뉴·편집 권한만 다룬다.

## 4. 데이터·검증·배포

### 결정 10. 결재 저장소
- **결정:** 고객 VM의 j-groupware PostgreSQL 인스턴스에 j-approval 전용 database `jgw_approval`과 전용 계정을 둔다(architecture.md 3장 서비스 가입 모델, A안). 드라이버 `pg`, 마이그레이션 node-pg-migrate SQL 파일, SQL 직접 작성, 버전 정확히 고정. 모든 테이블에 `tenant_id`를 두고 데이터 접근 함수가 tenant를 필수 인자로 강제한다. 허용 tenant 목록 밖 요청은 거절한다.
- **이유:** j-customer-auth-db 결정 1·9, j-groupware 결정 6-1·6-2와 같은 규칙.

### 결정 11. 저장소·테스트·배포
- **결정:**
  - j-messenger에서 workspaces·도구·scripts를 복사해 줄이고 버전을 같게 고정한다(`apps/server`, `packages/contracts`).
  - Vitest로 실제 j-auth·Keycloak·PostgreSQL에 API 시나리오를 검증한다. 결재선은 테스트가 상신 요청에 직접 넣으므로 j-groupware 서버가 필요 없다(2026-10-07 결정 4 갱신). 화면 e2e는 j-groupware G16에서 한다.
  - 로컬 완료 후 고객 VM에서 systemd·내부 포트·로컬 인증서 HTTPS로 다시 검증한다. 비표준 기본 포트 + 설정 변경, 3001 미사용.
- **이유:** j-customer-auth-db 결정 10, j-mail 결정 8과 같은 원칙. 사용자가 Item 구성(A1·A7·A8)을 승인했다.

## 5. 작업 구성

### 결정 0. PMT 계층과 Item 구성
PMT 계층은 environment `j-groupware-suite` → repository `j-approval`(`0472dab6-26a6-48bf-b298-2cd7787f8b54`) → project `j-approval`(`f8bf6842-6cb3-4f35-8997-832291aeb5f4`)이다. Work W1 "j-approval 최소 구현"(`278db342-656a-4428-8b13-660520906b4b`)의 완료 기준은 0장 완료 기준과 같다. 사용자가 제안 구성을 승인했다.

| 순서 | Item | 완료 기준 요약 | 선행 |
| --- | --- | --- | --- |
| A1 | 저장소 골격 | workspaces(apps/server, packages/contracts), j-messenger 도구 복사·버전 고정, `jgw_approval` database·전용 계정·마이그레이션, 로컬 HTTPS·비표준 포트, 비밀값은 Git 제외 env | j-auth I4 |
| A2 | contracts | 상신(결재선 포함)·조회·결재함·승인·반려 API, 상태·이력 형식, 결재선 검증 규칙, 오류 코드, `npm pack` 가능 | A1 |
| A3 | 변경 요청 | 6장 요청 R1~R6 등록, 반영 확인(2026-10-07 완료, PMT finish 대기) | - |
| A4 | 인증·권한 게이트 | j-auth contracts vendor, Bearer 검증(aud `j-approval`), 허용 tenant, `approval:use`·기본 거부, 401/403/503 구분 | A2, j-auth I2·I4 |
| A5 | 문서·결재 엔진 | tenant_id 테이블, 상신 시 결재선 스냅샷, 지정자만 처리, 순차 전이·반려 사유·종결 후 불변, 동시 처리 보호, append-only 이력, 내 문서·결재함 | A4 |
| A6 | 결재선 검증 | 상신 요청의 결재선 검증(1단계 이상, 중복 없음, 작성자 제외), 위반 시 400, 스냅샷 저장, 지정자 `sub`·`tenant` 일치 검사 | A5 |
| A7 | 완료 기준 테스트 | 실제 의존성 Vitest(계정 `a-appr1`~`a-appr4`, `a-member`, `b-admin`): N단계 승인, 반려, 비지정자 403, 결재선 규칙 위반 400, tenant 격리, 401·503 | A5, A6 |
| A8 | 고객 VM 검증 | VM에서 `deploy/provision-service`로 database 생성, systemd·내부 포트, j-groupware 화면 상신 → 결재 → 이력, VM 대상 A7 통과 | A7, j-groupware G10·G16·G18 |

backlog: 합의·병렬·참조, 대결·전결 위임, 문서 양식 다종, 첨부, 알림(j-mail·메신저). Bearer→세션 기반 인증 전환은 j-groupware OIDC 전환 backlog로 옮겼다.

## 6. 다른 서비스에 넘길 변경 요청

2026-10-07 각 대상 프로젝트 PMT에 backlog 레코드로 등록했다. 같은 날 모두 반영되었다(PMT 레코드 상태 갱신 대기).
- R1~R3 → j-auth 결정 24(Item I2·I3·I4·I6 보강)
- R4 → j-groupware 결정 21, G15. 조직도 조회 API와 계정 디렉터리 API는 결재선을 j-groupware가 만들게 되어 필요 없어졌다.
- R5 → j-groupware 결정 21, G16
- R6 → architecture.md 갱신

| 번호 | 대상 | 요청 | PMT 레코드 |
| --- | --- | --- | --- |
| R1 | j-auth | 고객 realm에 role 전용 client `j-approval`과 `approval:use`, client `j-groupware`에 `org:manage`, `tenant:admin` 묶음에 둘 다 포함, `j-auth` client scope mapping 추가 | `c1e2788e-582a-4eb2-861e-2ae05b89b630` |
| R2 | j-auth | `j-auth` client audience mapper와 contracts aud 상수에 `j-approval` 추가 | `df820d52-b4a3-4c7a-8383-d3f2b31477ba` |
| R3 | j-auth | 회원 관리 API 부여 가능 role에 `approval:use`·`org:manage`, 순차 결재선 테스트 계정(작성자, 결재자 2명 이상, 결재선 밖 회원, 권한 없는 회원) | `085152fb-e85a-4bb5-a90b-f9adc4dbbc3a` |
| R4 | j-groupware | 조직도 데이터(DB)·편집 화면(`org:manage`)·조회 API(Bearer), 같은 tenant 계정 디렉터리 조회 API | `73d710c8-1c50-4ebd-bd6d-89c731dfbdb1` |
| R5 | j-groupware | 결재 메뉴(`approval:use`)와 화면(상신·결재선·내 문서·결재함·상태/이력·승인/반려), Bearer 중계, 회원 관리 화면에서 두 권한 부여, contracts `.tgz`는 A2 완료 후 제공 | `7879c454-b5a0-44e7-9bb7-7031247da3c0` |
| R6 | j-groupware | architecture.md §1·§4·§5의 j-approval 서술 갱신(대상, 범위·완료 기준, 의존성) | `d8bea411-75f0-4ed8-800a-9e1591eb49e7` |

참고: j-customer-auth-db 결정 2의 손님 JWT 소비자 예시에서 j-approval을 뺐다(2026-10-07).
