--
-- PostgreSQL database dump
--

\restrict LV8K9vrAXxaGE37BVctIaJ0sGxSPv34OOeEAuG6BNFQ9XNNwpxmQ7NnWdm3kofW

-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

ALTER TABLE IF EXISTS ONLY public."Credential" DROP CONSTRAINT IF EXISTS "Credential_domainId_fkey";
DROP INDEX IF EXISTS public."Domain_name_key";
DROP INDEX IF EXISTS public."Credential_email_domainId_key";
ALTER TABLE IF EXISTS ONLY public._prisma_migrations DROP CONSTRAINT IF EXISTS _prisma_migrations_pkey;
ALTER TABLE IF EXISTS ONLY public."Domain" DROP CONSTRAINT IF EXISTS "Domain_pkey";
ALTER TABLE IF EXISTS ONLY public."Credential" DROP CONSTRAINT IF EXISTS "Credential_pkey";
ALTER TABLE IF EXISTS ONLY public."AuthKey" DROP CONSTRAINT IF EXISTS "AuthKey_pkey";
ALTER TABLE IF EXISTS public."Domain" ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public."Credential" ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public."AuthKey" ALTER COLUMN id DROP DEFAULT;
DROP TABLE IF EXISTS public._prisma_migrations;
DROP SEQUENCE IF EXISTS public."Domain_id_seq";
DROP TABLE IF EXISTS public."Domain";
DROP SEQUENCE IF EXISTS public."Credential_id_seq";
DROP TABLE IF EXISTS public."Credential";
DROP SEQUENCE IF EXISTS public."AuthKey_id_seq";
DROP TABLE IF EXISTS public."AuthKey";
SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: AuthKey; Type: TABLE; Schema: public; Owner: chakib
--

CREATE TABLE public."AuthKey" (
    id integer NOT NULL,
    hash text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."AuthKey" OWNER TO chakib;

--
-- Name: AuthKey_id_seq; Type: SEQUENCE; Schema: public; Owner: chakib
--

CREATE SEQUENCE public."AuthKey_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public."AuthKey_id_seq" OWNER TO chakib;

--
-- Name: AuthKey_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: chakib
--

ALTER SEQUENCE public."AuthKey_id_seq" OWNED BY public."AuthKey".id;


--
-- Name: Credential; Type: TABLE; Schema: public; Owner: chakib
--

CREATE TABLE public."Credential" (
    id integer NOT NULL,
    "domainId" integer NOT NULL,
    username text,
    email text NOT NULL,
    password text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "lastTimeUsed" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."Credential" OWNER TO chakib;

--
-- Name: Credential_id_seq; Type: SEQUENCE; Schema: public; Owner: chakib
--

CREATE SEQUENCE public."Credential_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public."Credential_id_seq" OWNER TO chakib;

--
-- Name: Credential_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: chakib
--

ALTER SEQUENCE public."Credential_id_seq" OWNED BY public."Credential".id;


--
-- Name: Domain; Type: TABLE; Schema: public; Owner: chakib
--

CREATE TABLE public."Domain" (
    id integer NOT NULL,
    name text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public."Domain" OWNER TO chakib;

--
-- Name: Domain_id_seq; Type: SEQUENCE; Schema: public; Owner: chakib
--

CREATE SEQUENCE public."Domain_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public."Domain_id_seq" OWNER TO chakib;

--
-- Name: Domain_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: chakib
--

ALTER SEQUENCE public."Domain_id_seq" OWNED BY public."Domain".id;


--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: chakib
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


ALTER TABLE public._prisma_migrations OWNER TO chakib;

--
-- Name: AuthKey id; Type: DEFAULT; Schema: public; Owner: chakib
--

ALTER TABLE ONLY public."AuthKey" ALTER COLUMN id SET DEFAULT nextval('public."AuthKey_id_seq"'::regclass);


--
-- Name: Credential id; Type: DEFAULT; Schema: public; Owner: chakib
--

ALTER TABLE ONLY public."Credential" ALTER COLUMN id SET DEFAULT nextval('public."Credential_id_seq"'::regclass);


--
-- Name: Domain id; Type: DEFAULT; Schema: public; Owner: chakib
--

ALTER TABLE ONLY public."Domain" ALTER COLUMN id SET DEFAULT nextval('public."Domain_id_seq"'::regclass);


--
-- Data for Name: AuthKey; Type: TABLE DATA; Schema: public; Owner: chakib
--

COPY public."AuthKey" (id, hash, "createdAt", "updatedAt") FROM stdin;
1	ae86abfbd11a67264e44b95f36d79439c26a0451fe933be9540bd8a8e8c1b290	2026-03-10 21:46:32.277	2026-03-10 21:46:32.277
\.


--
-- Data for Name: Credential; Type: TABLE DATA; Schema: public; Owner: chakib
--

COPY public."Credential" (id, "domainId", username, email, password, "createdAt", "updatedAt", "lastTimeUsed") FROM stdin;
34	35	supabase account	Soheibbahi13@gmail.com	k9EzSlnkXYQ2o3ZN89jVXu1RyNDEHcXwlNB93lnFQ75oLniAQ7TRCnkf	2026-03-28 18:42:53.832	2026-03-28 18:42:53.832	2026-03-28 18:42:53.832
35	36	Master Azure	masterazure22@gmail.com	1qRoSQ2L7b43GD1cf2pU7+5tvlqeXQl0MUSahCCcejk0F8P3JIsHT6PafXnO	2026-03-28 18:43:49.463	2026-03-28 18:43:49.463	2026-03-28 18:43:49.463
36	37		grabachakib555@gmail.com	/pa124yRJraeAHODaHMjYnIpfKsFMObKnAQcSWn0b+Qf/163P1u2Pfwq	2026-03-28 18:45:08.252	2026-03-28 18:45:08.252	2026-03-28 18:45:08.252
37	38	Web Fi DZ	web.fi.dz.ent@gmail.com	x6Pro5v6EcEyUVElM8+7CWTLHGZGnvfzK4moakC85hf2E7zG07aGRF3NVQ==	2026-03-28 18:46:11.898	2026-03-28 18:46:11.898	2026-03-28 18:46:11.898
38	38	Nawel AI	anawel947@gmail.com	aemX2oVtoxqYyZNqCf+qCM8c1VHsFRRj2OE7Ey/J2Qp7RkLZpqY=	2026-03-28 18:46:59.768	2026-03-28 18:46:59.768	2026-03-28 18:46:59.768
39	40	chakib	chakibimaneclaude03@gmail.com	sDk4zr2Af+OF945i0YqvxyY/hdgN/5CMqEFliAn1jcYT+eQ0Uj1+JUEu96Y=	2026-03-28 18:48:18.33	2026-03-28 18:48:18.33	2026-03-28 18:48:18.33
40	36	Tonobilti	tonobilticars@gmail.com	dJQ9FOQC8UX2Esu/hjloZ6mHBE/NMhmY91T6C5PjBy6voPt4BMc4Nx49q/m9uQ==	2026-03-28 18:48:53.508	2026-03-28 18:48:53.508	2026-03-28 18:48:53.508
41	42	LastGamer2004	chakibdz02@gmail.com	1YDBuK/SAj/Kqa6cX8VQ0MH5pNbAbcAihMVsPWZWIDkarxj28FBbXQ==	2026-03-28 18:53:23.322	2026-03-28 18:53:23.322	2026-03-28 18:53:23.322
42	38	Mihoyo Account	diob37889@gmail.com	mu+/sud4alpGjVFnR2sBFw10AMl3J8XKwnpHvue5qm3T7mDkN4Yw	2026-03-28 18:53:57.916	2026-03-28 18:53:57.916	2026-03-28 18:53:57.916
46	43	CharEvil44 Xbox Account	grabachakib555@gmail.com	WcJr/gpQP8RM1OCL4S1L1YCyPaL1sxHGlSzamomb5v+BXtqV8eCB	2026-03-28 19:02:02.587	2026-03-28 19:02:02.587	2026-03-28 19:02:02.587
47	38	Chakib Graba Main	grabachakib008@gmail.com	ykdfdx6bPHqMQkcFIn1E37uYziTRxXB6vpI0+7sPWA/eKDNQydZV7A==	2026-03-28 19:02:53.072	2026-03-28 19:02:53.072	2026-03-28 19:02:53.072
48	45	Main Account	lzrgmehdi@gmail.com	LK2M2Ntyk6toHdZWZUNjKuqjHwF6QajE/my8uLKAQoZ2dh3gqlf2iNc=	2026-03-28 19:04:10.825	2026-03-28 19:04:10.825	2026-03-28 19:04:10.825
49	46	Main Account	grabachakib008@gmail.com	QW6pzXpMxJrs70a6PZ1oS2Dk3t2k6hvsCvpOs+0b6y/XiylHRHBK3h/A	2026-03-28 19:05:28.399	2026-03-28 19:05:28.399	2026-03-28 19:05:28.399
50	47	Random Account	aljbalawlyukissam@gmail.com	5JFfL34dDkCU+9Bb0BVhNXe4xr4BkC8Z3uydXpCGVg8R1QqFguFArkQ=	2026-03-28 19:06:41.492	2026-03-28 19:06:41.492	2026-03-28 19:06:41.492
51	49	Main Account	grabachakib008@gmail.com	Yf3P7mYCP04NIBjEadaDw61ujnt0lOlGy5dXgNiq0+bbPV2klwNfda4=	2026-03-28 19:07:25.877	2026-03-28 19:07:25.877	2026-03-28 19:07:25.877
52	50	Main Account	trondio466@gmail.com	7m777U5qQSdpwdZf+7LKu2xy+kibbJqaYtRuyyPnBWEEHUX1ia7pPRA=	2026-03-28 19:08:00.313	2026-03-28 19:08:00.313	2026-03-28 19:08:00.313
53	38	Chakib Bruh On yt	grabachakib555@gmail.com	ifv0junrZfOTd6to6JPV84ysE7YG8Y2FFHdQDKdSH2FykDhsktXBmfRi	2026-03-28 19:08:33.737	2026-03-28 19:08:33.737	2026-03-28 19:08:33.737
54	51	Main Account	grabachakib555@gmail.com	bh9YiQ4aOEvT80Q4EmAcD47Lwtw9j3BQkSzgjHEC1e+qdOfB9e1iGw==	2026-03-28 19:09:10.702	2026-03-28 19:09:10.702	2026-03-28 19:09:10.702
55	52	diohaverizz22	norecordedEmail@no.com	F/Oi/ELJ3BN79VapqXD4hQ29a4o+a4QiKtwjuHVuFW//mAFccZpeyr0o	2026-03-28 19:10:20.98	2026-03-28 19:10:20.98	2026-03-28 19:10:20.98
56	38	Minecraft Account	thebestdio200@gmail.com	QtniJOzIaJQXDZ5LuvCIqvfXToye1B0RazyAUitPMqW3xRpNVQs=	2026-03-28 19:11:05.432	2026-03-28 19:11:05.432	2026-03-28 19:11:05.432
57	53	chaky-dio67	grabachakib555@gmail.com	Q6TW4Nhig/WdEkI2JWsB6qcAFQxDi50VlLe/m2+IHMCoQqOQyMyL3K4=	2026-03-28 19:21:05.728	2026-03-28 19:21:05.728	2026-03-28 19:21:05.728
58	54	Main Account	grabachakib008@gmail.com	fBWA00tjehlDtDVEmam0CEHo0Dzi2l15kwU9Xh6vaz/8s2TVd11bdVU=	2026-03-28 19:21:47.642	2026-03-28 19:21:47.642	2026-03-28 19:21:47.642
59	55	Chakibceran22	grabachakib008@gmail.com	KHNNr9l0n2ZL2GUZhhIBe0xx7xIJ/9WGGn+IQcWtiHdwr4jLE3ABA7g=	2026-03-28 19:22:24.394	2026-03-28 19:22:24.394	2026-03-28 19:22:24.394
60	56	Main Account	grabachakib555@gmail.com	R1JR0kWi5W/O7yyad9ESNsCyXL9lNHbhWVxQd40rNTs27pO2c4QANg==	2026-03-28 19:23:00.991	2026-03-28 19:23:00.991	2026-03-28 19:23:00.991
61	57	Graba Chakib	grabachakib555@gmail.com	+Iy/qFY5WiO6kaC/Q4zWN0YbBuS+lGHT8Z1E3G3hCmscdM4S9+rkYPc=	2026-03-28 19:23:39.398	2026-03-28 19:23:39.398	2026-03-28 19:23:39.398
62	58	Graba Chakib	grabachakib008@gmail.com	3U5WDCNgLfoFtZ5ONBmnQ/Nvd8n/Xe5jMrzr5OX+VZYNLq343gMrsQ==	2026-03-28 19:25:28.783	2026-03-28 19:25:28.783	2026-03-28 19:25:28.783
63	59	chakib imane	chakibimaneclaude03@gmail.com	syF4UKJ9Wb0X6q+TEh5PDCWLPGdA/r9HklIMWCxzWqocZJS1yYgcMHpK	2026-03-28 19:26:05.817	2026-03-28 19:26:05.817	2026-03-28 19:26:05.817
64	38	Arch Linux Account	archlinux992@gmail.com	z8KfQbRn7KePv4U6XqNMpAGPH5snJQUFVgXSMaECf8Y8kqw83fniBi9ACHbRJdk=	2026-03-28 19:26:53.037	2026-03-28 19:26:53.037	2026-03-28 19:26:53.037
65	60	Main Phone Number	grabachakib008@gmail.com	h1P5T5s0HAqoWiP9wk8rgFiVG3POeqxYGwyRNrhckygQHeaB7yHzEQ==	2026-03-28 19:27:34.999	2026-03-28 19:27:34.999	2026-03-28 19:27:34.999
66	61	chakibgrb	grabachakib008@gmail.com	HFj8eNXYWWvHsHhNjW+JIbAJMUQ2KtNJZybbwp5VJ5XtOasUxfw2tsCWw249	2026-03-29 18:46:26.692	2026-03-29 18:46:26.692	2026-03-29 18:46:26.692
67	62	nothing	chakibislam.graba@etu.usthb.dz	meL034K3vDdEhIKp5ww4bUW9l10v2YZCnJ4rMH143PpRPmdDKkB355Wo	2026-05-08 14:10:56.851	2026-05-08 14:10:56.851	2026-05-08 14:10:56.851
68	38	aura tech vercel(gmail)	auratechvercel@gmail.com	LoCwQzH70zwaY4rCOVwTN1BwYpRLDaW3uUIkHM3Dr/bWSSIlcLqHYdY=	2026-05-25 20:06:24.103	2026-05-25 20:06:24.103	2026-05-25 20:06:24.103
\.


--
-- Data for Name: Domain; Type: TABLE DATA; Schema: public; Owner: chakib
--

COPY public."Domain" (id, name, "createdAt", "updatedAt") FROM stdin;
35	auratech.com	2026-03-28 18:42:15.479	2026-03-28 18:42:15.479
36	supabase.com	2026-03-28 18:43:19.415	2026-03-28 18:43:19.415
37	dockerhub.com	2026-03-28 18:44:35.228	2026-03-28 18:44:35.228
38	google.com	2026-03-28 18:45:28.479	2026-03-28 18:45:28.479
40	proton.com	2026-03-28 18:48:00.94	2026-03-28 18:48:00.94
42	playstation.com	2026-03-28 18:52:01.991	2026-03-28 18:52:01.991
43	microsoft.com	2026-03-28 18:54:11.496	2026-03-28 18:54:11.496
45	AfkArena.com	2026-03-28 19:03:41.59	2026-03-28 19:03:41.59
46	discord.com	2026-03-28 19:05:01.336	2026-03-28 19:05:01.336
47	BattleNet.com	2026-03-28 19:05:42.889	2026-03-28 19:05:42.889
49	Instagram.com	2026-03-28 19:07:06.001	2026-03-28 19:07:06.001
50	Bethesda.com	2026-03-28 19:07:35.841	2026-03-28 19:07:35.841
51	EpicGames.com	2026-03-28 19:08:44.93	2026-03-28 19:08:44.93
52	Steam.com	2026-03-28 19:09:36.342	2026-03-28 19:09:36.342
53	Unity.com	2026-03-28 19:20:28.345	2026-03-28 19:20:28.345
54	Samsung.com	2026-03-28 19:21:15.481	2026-03-28 19:21:15.481
55	Github.com	2026-03-28 19:21:57.242	2026-03-28 19:21:57.242
56	Payonner.com	2026-03-28 19:22:34.228	2026-03-28 19:22:34.228
57	Upwork.com	2026-03-28 19:23:16.643	2026-03-28 19:23:16.643
58	AWS.com	2026-03-28 19:23:52.509	2026-03-28 19:23:52.509
59	Claude.com	2026-03-28 19:25:36.195	2026-03-28 19:25:36.195
60	Dukascopy.com	2026-03-28 19:27:05.491	2026-03-28 19:27:05.491
61	IBKR.com	2026-03-29 18:45:36.34	2026-03-29 18:45:36.34
62	usthb.com	2026-05-08 14:08:59.786	2026-05-08 14:08:59.786
\.


--
-- Data for Name: _prisma_migrations; Type: TABLE DATA; Schema: public; Owner: chakib
--

COPY public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;
a3065e64-0adc-4529-ab59-816d73fd21ad	522ba9ccf00c1cf0a475007fe17922eee199c4c762cef2f06230f698df475a4b	2026-03-10 21:46:14.037474+00	20260302195403_init	\N	\N	2026-03-10 21:46:14.028209+00	1
5a3f06bd-8b42-4f96-ad6b-380347f1a2a2	f2993d5bebb8911f198494911476b3668e27c4e71dff53d18f9793273f779c00	2026-03-10 21:46:14.051308+00	20260304141101_refactor_masterpassword_into_authkey	\N	\N	2026-03-10 21:46:14.038163+00	1
af7c26ff-87f8-4c23-a9d3-4cbb39e7493c	1f37eff58edf4ef7458e7d99858a4beb14c1827bad5d8f3585f8f8731f80a0aa	2026-03-10 21:46:14.073284+00	20260304200357_creating_cred_domain	\N	\N	2026-03-10 21:46:14.0521+00	1
a22bb3b5-58b3-470a-b0dc-babcc31dc90d	71c9d5b9607e2fd17c68c690bfeb486db3843362e4c935c3f3f706cd7ea2935e	2026-03-10 21:46:14.083684+00	20260304201258_changing_field_req	\N	\N	2026-03-10 21:46:14.075091+00	1
0e699519-38fb-47c1-b57d-3e2366b6678e	ec747f7b9e03cf0522485c810eda4188e52c2c7f8bf308db4e1e4e31c7db8f8a	2026-03-10 21:46:14.094807+00	20260304203018_changing_small_issue	\N	\N	2026-03-10 21:46:14.085141+00	1
d1c98ac7-fc71-4627-b884-0ea78057c0bb	21bee6b3484e48ae7caf0034768cf79782d694285cf444f29a2a8919161109ee	2026-03-10 21:46:14.100065+00	20260304214639_dropping_total_counts	\N	\N	2026-03-10 21:46:14.09562+00	1
8148940e-e52d-4c71-aae8-fd1ccfcee6bb	622d6b07dba9232fc889f389bd0adfa43c1a13a30584540d8af055771049d8e0	2026-03-10 21:46:14.109354+00	20260306223525_cascade_delet_on_cred	\N	\N	2026-03-10 21:46:14.100711+00	1
bf0d5f8a-833a-4c88-bb75-67497ce2b6b0	manual_fix	2026-03-28 19:01:36.45314+00	20260328000000_fix_credential_unique_constraint	\N	\N	2026-03-28 19:01:36.45314+00	1
\.


--
-- Name: AuthKey_id_seq; Type: SEQUENCE SET; Schema: public; Owner: chakib
--

SELECT pg_catalog.setval('public."AuthKey_id_seq"', 33, true);


--
-- Name: Credential_id_seq; Type: SEQUENCE SET; Schema: public; Owner: chakib
--

SELECT pg_catalog.setval('public."Credential_id_seq"', 68, true);


--
-- Name: Domain_id_seq; Type: SEQUENCE SET; Schema: public; Owner: chakib
--

SELECT pg_catalog.setval('public."Domain_id_seq"', 62, true);


--
-- Name: AuthKey AuthKey_pkey; Type: CONSTRAINT; Schema: public; Owner: chakib
--

ALTER TABLE ONLY public."AuthKey"
    ADD CONSTRAINT "AuthKey_pkey" PRIMARY KEY (id);


--
-- Name: Credential Credential_pkey; Type: CONSTRAINT; Schema: public; Owner: chakib
--

ALTER TABLE ONLY public."Credential"
    ADD CONSTRAINT "Credential_pkey" PRIMARY KEY (id);


--
-- Name: Domain Domain_pkey; Type: CONSTRAINT; Schema: public; Owner: chakib
--

ALTER TABLE ONLY public."Domain"
    ADD CONSTRAINT "Domain_pkey" PRIMARY KEY (id);


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: chakib
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: Credential_email_domainId_key; Type: INDEX; Schema: public; Owner: chakib
--

CREATE UNIQUE INDEX "Credential_email_domainId_key" ON public."Credential" USING btree (email, "domainId");


--
-- Name: Domain_name_key; Type: INDEX; Schema: public; Owner: chakib
--

CREATE UNIQUE INDEX "Domain_name_key" ON public."Domain" USING btree (name);


--
-- Name: Credential Credential_domainId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: chakib
--

ALTER TABLE ONLY public."Credential"
    ADD CONSTRAINT "Credential_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES public."Domain"(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict LV8K9vrAXxaGE37BVctIaJ0sGxSPv34OOeEAuG6BNFQ9XNNwpxmQ7NnWdm3kofW

