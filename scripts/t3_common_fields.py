"""T3 common company schema: shared field logic for TankBazaar (17 Nov 2026).

Used by scripts/t3_merge_export.py (the merge export) and by the companies seeder
build, so the Firestore company documents and the export carry the same values.
Pure standard library; no network access. See T3_DECISIONS.md section 13.
"""
import re

COUNTRY_NAMES = {
"AD": "Andorra",
"AE": "United Arab Emirates",
"AF": "Afghanistan",
"AG": "Antigua and Barbuda",
"AI": "Anguilla",
"AL": "Albania",
"AM": "Armenia",
"AN": "Netherlands Antilles",
"AO": "Angola",
"AQ": "Antarctica",
"AR": "Argentina",
"AS": "American Samoa",
"AT": "Austria",
"AU": "Australia",
"AW": "Aruba",
"AX": "Aland Islands",
"AZ": "Azerbaijan",
"BA": "Bosnia and Herzegovina",
"BB": "Barbados",
"BD": "Bangladesh",
"BE": "Belgium",
"BF": "Burkina Faso",
"BG": "Bulgaria",
"BH": "Bahrain",
"BI": "Burundi",
"BJ": "Benin",
"BL": "Saint Barthelemy",
"BM": "Bermuda",
"BN": "Brunei",
"BO": "Bolivia",
"BQ": "Caribbean Netherlands",
"BR": "Brazil",
"BS": "Bahamas",
"BT": "Bhutan",
"BV": "Bouvet Island",
"BW": "Botswana",
"BY": "Belarus",
"BZ": "Belize",
"CA": "Canada",
"CC": "Cocos Islands",
"CD": "DR Congo",
"CF": "Central African Republic",
"CG": "Republic of the Congo",
"CH": "Switzerland",
"CI": "Côte d'Ivoire",
"CK": "Cook Islands",
"CL": "Chile",
"CM": "Cameroon",
"CN": "China",
"CO": "Colombia",
"CR": "Costa Rica",
"CS": "Serbia and Montenegro",
"CU": "Cuba",
"CV": "Cape Verde",
"CW": "Curacao",
"CX": "Christmas Island",
"CY": "Cyprus",
"CZ": "Czechia",
"DE": "Germany",
"DJ": "Djibouti",
"DK": "Denmark",
"DM": "Dominica",
"DO": "Dominican Republic",
"DZ": "Algeria",
"EC": "Ecuador",
"EE": "Estonia",
"EG": "Egypt",
"EH": "Western Sahara",
"ER": "Eritrea",
"ES": "Spain",
"ET": "Ethiopia",
"FI": "Finland",
"FJ": "Fiji",
"FK": "Falkland Islands",
"FM": "Micronesia",
"FO": "Faroe Islands",
"FR": "France",
"GA": "Gabon",
"GB": "United Kingdom",
"GD": "Grenada",
"GE": "Georgia",
"GF": "French Guiana",
"GG": "Guernsey",
"GH": "Ghana",
"GI": "Gibraltar",
"GL": "Greenland",
"GM": "Gambia",
"GN": "Guinea",
"GP": "Guadeloupe",
"GQ": "Equatorial Guinea",
"GR": "Greece",
"GS": "South Georgia and the South Sandwich Islands",
"GT": "Guatemala",
"GU": "Guam",
"GW": "Guinea-Bissau",
"GY": "Guyana",
"HK": "Hong Kong",
"HM": "Heard Island and McDonald Islands",
"HN": "Honduras",
"HR": "Croatia",
"HT": "Haiti",
"HU": "Hungary",
"ID": "Indonesia",
"IE": "Ireland",
"IL": "Israel",
"IM": "Isle of Man",
"IN": "India",
"IO": "British Indian Ocean Territory",
"IQ": "Iraq",
"IR": "Iran",
"IS": "Iceland",
"IT": "Italy",
"JE": "Jersey",
"JM": "Jamaica",
"JO": "Jordan",
"JP": "Japan",
"KE": "Kenya",
"KG": "Kyrgyzstan",
"KH": "Cambodia",
"KI": "Kiribati",
"KM": "Comoros",
"KN": "Saint Kitts and Nevis",
"KP": "North Korea",
"KR": "South Korea",
"KW": "Kuwait",
"KY": "Cayman Islands",
"KZ": "Kazakhstan",
"LA": "Laos",
"LB": "Lebanon",
"LC": "Saint Lucia",
"LI": "Liechtenstein",
"LK": "Sri Lanka",
"LR": "Liberia",
"LS": "Lesotho",
"LT": "Lithuania",
"LU": "Luxembourg",
"LV": "Latvia",
"LY": "Libya",
"MA": "Morocco",
"MC": "Monaco",
"MD": "Moldova",
"ME": "Montenegro",
"MF": "Saint Martin",
"MG": "Madagascar",
"MH": "Marshall Islands",
"MK": "North Macedonia",
"ML": "Mali",
"MM": "Myanmar",
"MN": "Mongolia",
"MO": "Macao",
"MP": "Northern Mariana Islands",
"MQ": "Martinique",
"MR": "Mauritania",
"MS": "Montserrat",
"MT": "Malta",
"MU": "Mauritius",
"MV": "Maldives",
"MW": "Malawi",
"MX": "Mexico",
"MY": "Malaysia",
"MZ": "Mozambique",
"NA": "Namibia",
"NC": "New Caledonia",
"NE": "Niger",
"NF": "Norfolk Island",
"NG": "Nigeria",
"NI": "Nicaragua",
"NL": "Netherlands",
"NO": "Norway",
"NP": "Nepal",
"NR": "Nauru",
"NU": "Niue",
"NZ": "New Zealand",
"OM": "Oman",
"PA": "Panama",
"PE": "Peru",
"PF": "French Polynesia",
"PG": "Papua New Guinea",
"PH": "Philippines",
"PK": "Pakistan",
"PL": "Poland",
"PM": "Saint Pierre and Miquelon",
"PN": "Pitcairn",
"PR": "Puerto Rico",
"PS": "Palestine",
"PT": "Portugal",
"PW": "Palau",
"PY": "Paraguay",
"QA": "Qatar",
"RE": "Reunion",
"RO": "Romania",
"RS": "Serbia",
"RU": "Russia",
"RW": "Rwanda",
"SA": "Saudi Arabia",
"SB": "Solomon Islands",
"SC": "Seychelles",
"SD": "Sudan",
"SE": "Sweden",
"SG": "Singapore",
"SH": "Saint Helena",
"SI": "Slovenia",
"SJ": "Svalbard and Jan Mayen",
"SK": "Slovakia",
"SL": "Sierra Leone",
"SM": "San Marino",
"SN": "Senegal",
"SO": "Somalia",
"SR": "Suriname",
"SS": "South Sudan",
"ST": "Sao Tome and Principe",
"SV": "El Salvador",
"SX": "Sint Maarten",
"SY": "Syria",
"SZ": "Eswatini",
"TC": "Turks and Caicos Islands",
"TD": "Chad",
"TF": "French Southern Territories",
"TG": "Togo",
"TH": "Thailand",
"TJ": "Tajikistan",
"TK": "Tokelau",
"TL": "Timor-Leste",
"TM": "Turkmenistan",
"TN": "Tunisia",
"TO": "Tonga",
"TR": "Turkey",
"TT": "Trinidad and Tobago",
"TV": "Tuvalu",
"TW": "Taiwan",
"TZ": "Tanzania",
"UA": "Ukraine",
"UG": "Uganda",
"UM": "United States Minor Outlying Islands",
"US": "United States",
"UY": "Uruguay",
"UZ": "Uzbekistan",
"VA": "Vatican City",
"VC": "Saint Vincent and the Grenadines",
"VE": "Venezuela",
"VG": "British Virgin Islands",
"VI": "U.S. Virgin Islands",
"VN": "Vietnam",
"VU": "Vanuatu",
"WF": "Wallis and Futuna",
"WS": "Samoa",
"XK": "Kosovo",
"YE": "Yemen",
"YT": "Mayotte",
"ZA": "South Africa",
"ZM": "Zambia",
"ZW": "Zimbabwe"
}

COUNTRY_BY_NAME = {
"afghanistan": "AF",
"aland islands": "AX",
"albania": "AL",
"algeria": "DZ",
"american samoa": "AS",
"andorra": "AD",
"angola": "AO",
"anguilla": "AI",
"antarctica": "AQ",
"antigua and barbuda": "AG",
"argentina": "AR",
"armenia": "AM",
"aruba": "AW",
"ascension island": "SH",
"australia": "AU",
"austria": "AT",
"azerbaijan": "AZ",
"bahamas": "BS",
"bahrain": "BH",
"bangladesh": "BD",
"barbados": "BB",
"belarus": "BY",
"belgium": "BE",
"belize": "BZ",
"benin": "BJ",
"bermuda": "BM",
"bhutan": "BT",
"bolivia": "BO",
"bonaire": "BQ",
"bonaire, saint eustatius and saba ": "BQ",
"bosnia and herzegovina": "BA",
"botswana": "BW",
"bouvet island": "BV",
"brazil": "BR",
"british indian ocean territory": "IO",
"british virgin islands": "VG",
"brunei": "BN",
"bulgaria": "BG",
"burkina faso": "BF",
"burundi": "BI",
"cabo verde": "CV",
"cambodia": "KH",
"cameroon": "CM",
"canada": "CA",
"cape verde": "CV",
"caribbean netherlands": "BQ",
"cayman islands": "KY",
"central african republic": "CF",
"chad": "TD",
"chile": "CL",
"china": "CN",
"christmas island": "CX",
"cocos islands": "CC",
"colombia": "CO",
"comoros": "KM",
"cook islands": "CK",
"costa rica": "CR",
"cote d'ivoire": "CI",
"croatia": "HR",
"cuba": "CU",
"curacao": "CW",
"cyprus": "CY",
"czech republic": "CZ",
"czechia": "CZ",
"côte d'ivoire": "CI",
"democratic republic of the congo": "CD",
"denmark": "DK",
"djibouti": "DJ",
"dominica": "DM",
"dominican republic": "DO",
"dr congo": "CD",
"drc": "CD",
"ecuador": "EC",
"egypt": "EG",
"el salvador": "SV",
"equatorial guinea": "GQ",
"eritrea": "ER",
"estonia": "EE",
"eswatini": "SZ",
"ethiopia": "ET",
"falkland islands": "FK",
"faroe islands": "FO",
"federated states of micronesia": "FM",
"fiji": "FJ",
"finland": "FI",
"france": "FR",
"french guiana": "GF",
"french polynesia": "PF",
"french southern territories": "TF",
"gabon": "GA",
"gambia": "GM",
"georgia": "GE",
"germany": "DE",
"ghana": "GH",
"gibraltar": "GI",
"greece": "GR",
"greenland": "GL",
"grenada": "GD",
"guadeloupe": "GP",
"guam": "GU",
"guatemala": "GT",
"guernsey": "GG",
"guinea": "GN",
"guinea-bissau": "GW",
"guyana": "GY",
"haiti": "HT",
"heard island and mcdonald islands": "HM",
"honduras": "HN",
"hong kong": "HK",
"hungary": "HU",
"iceland": "IS",
"india": "IN",
"indonesia": "ID",
"iran": "IR",
"iraq": "IQ",
"ireland": "IE",
"isle of man": "IM",
"israel": "IL",
"italy": "IT",
"ivory coast": "CI",
"jamaica": "JM",
"japan": "JP",
"jersey": "JE",
"jordan": "JO",
"kazakhstan": "KZ",
"kenya": "KE",
"kiribati": "KI",
"kosovo": "XK",
"kuwait": "KW",
"kyrgyzstan": "KG",
"laos": "LA",
"latvia": "LV",
"lebanon": "LB",
"lesotho": "LS",
"liberia": "LR",
"libya": "LY",
"liechtenstein": "LI",
"lithuania": "LT",
"luxembourg": "LU",
"macao": "MO",
"madagascar": "MG",
"malawi": "MW",
"malaysia": "MY",
"maldives": "MV",
"mali": "ML",
"malta": "MT",
"marshall islands": "MH",
"martinique": "MQ",
"mauritania": "MR",
"mauritius": "MU",
"mayotte": "YT",
"mexico": "MX",
"micronesia": "FM",
"moldova": "MD",
"monaco": "MC",
"mongolia": "MN",
"montenegro": "ME",
"montserrat": "MS",
"morocco": "MA",
"mozambique": "MZ",
"myanmar": "MM",
"namibia": "NA",
"nauru": "NR",
"nepal": "NP",
"netherlands": "NL",
"netherlands antilles": "AN",
"new caledonia": "NC",
"new zealand": "NZ",
"nicaragua": "NI",
"niger": "NE",
"nigeria": "NG",
"niue": "NU",
"norfolk island": "NF",
"north korea": "KP",
"north macedonia": "MK",
"northern mariana islands": "MP",
"norway": "NO",
"oman": "OM",
"pakistan": "PK",
"palau": "PW",
"palestine": "PS",
"palestinian territory": "PS",
"panama": "PA",
"papua new guinea": "PG",
"paraguay": "PY",
"peru": "PE",
"philippines": "PH",
"pitcairn": "PN",
"poland": "PL",
"portugal": "PT",
"puerto rico": "PR",
"qatar": "QA",
"republic of the congo": "CG",
"reunion": "RE",
"romania": "RO",
"russia": "RU",
"rwanda": "RW",
"saint barthelemy": "BL",
"saint helena": "SH",
"saint kitts and nevis": "KN",
"saint lucia": "LC",
"saint martin": "MF",
"saint pierre and miquelon": "PM",
"saint vincent and the grenadines": "VC",
"samoa": "WS",
"san marino": "SM",
"sao tome and principe": "ST",
"saudi arabia": "SA",
"senegal": "SN",
"serbia": "RS",
"serbia and montenegro": "CS",
"seychelles": "SC",
"sierra leone": "SL",
"singapore": "SG",
"sint maarten": "SX",
"slovakia": "SK",
"slovenia": "SI",
"solomon islands": "SB",
"somalia": "SO",
"somaliland": "SO",
"south africa": "ZA",
"south georgia and the south sandwich islands": "GS",
"south korea": "KR",
"south sudan": "SS",
"spain": "ES",
"sri lanka": "LK",
"st eustatius": "BQ",
"st. lucia": "LC",
"sudan": "SD",
"suriname": "SR",
"svalbard and jan mayen": "SJ",
"sweden": "SE",
"switzerland": "CH",
"syria": "SY",
"taiwan": "TW",
"tajikistan": "TJ",
"tanzania": "TZ",
"thailand": "TH",
"the netherlands": "NL",
"timor leste": "TL",
"timor-leste": "TL",
"togo": "TG",
"tokelau": "TK",
"tonga": "TO",
"trinidad and tobago": "TT",
"tristan da cunha": "SH",
"tunisia": "TN",
"turkey": "TR",
"turkmenistan": "TM",
"turks and caicos islands": "TC",
"tuvalu": "TV",
"u.s. virgin islands": "VI",
"uae": "AE",
"uganda": "UG",
"uk": "GB",
"ukraine": "UA",
"united arab emirates": "AE",
"united kingdom": "GB",
"united states": "US",
"united states minor outlying islands": "UM",
"uruguay": "UY",
"us virgin islands": "VI",
"usa": "US",
"usa/canada": "US",
"uzbekistan": "UZ",
"vanuatu": "VU",
"vatican": "VA",
"vatican city": "VA",
"venezuela": "VE",
"vietnam": "VN",
"wallis and futuna": "WF",
"western sahara": "EH",
"yemen": "YE",
"zambia": "ZM",
"zimbabwe": "ZW"
}

CODE_FIX = {'USA': 'US', 'UK': 'GB'}

PROCESS_LABEL = {
    'refineries': ('refinery', 'refineries'),
    'petrochemicals': ('petrochemical plant', 'petrochemical plants'),
    'chemicals': ('chemical plant', 'chemical plants'),
    'fertilisers': ('fertiliser plant', 'fertiliser plants'),
    'gas-processing-lng-lpg': ('gas processing, LNG or LPG plant', 'gas processing, LNG or LPG plants'),
    'offshore-production': ('offshore production facility', 'offshore production facilities'),
}
TYPE_MAP = {'port': 'port-terminal', 'inland': 'inland-terminal', 'floating': 'floating-facility', 'pipeline': 'pipeline'}
# Location type values allowed in the export (T3 section 13, decided 27 Nov 2026).
LOCATION_TYPES = ('port-terminal', 'inland-terminal', 'floating-facility', 'process-facility', 'pipeline')


def location_type(t):
    """T3 location type for one facility record. A process-only site (no storage class)
    is a process-facility, not a terminal (decided 27 Nov 2026)."""
    cls = t.get('facilityClass') or []
    raw = t.get('type')
    if raw == 'floating':
        return 'floating-facility'
    if 'process' in cls and 'storage' not in cls:
        return 'process-facility'
    return TYPE_MAP.get(raw, 'inland-terminal')
# Category for companies that own or operate a pipeline (added 22 Nov 2026 with pipeline locations).
PIPELINE_CATEGORY = 'pipelines'
PIPE_LABEL = ('pipeline', 'pipelines')
RELATIONSHIPS = ('subsidiary', 'joint-venture', 'division', 'brand-of')
SLUG_RE = re.compile(r'^[a-z0-9]+(-[a-z0-9]+)*$')
# Words that mark research notes, sources or tagging reasons. A public description must contain none.
NOTE_RE = re.compile(r'https?://|www\.|\bsource\b|\btier\b|\bverif|\bnote\b|\bTB\b|\bLEI\b|registry|\bCO\d{5}\b|\bper the\b|\bunconfirmed\b|\bLow\b', re.I)


def country_code(value):
    """ISO-2 code from a TankBazaar country value (code or English name)."""
    if not value:
        return ''
    v = str(value).strip()
    if v in CODE_FIX:
        return CODE_FIX[v]
    if len(v) == 2 and v.upper() in COUNTRY_NAMES:
        return v.upper()
    return COUNTRY_BY_NAME.get(v.lower(), '')


def country_name(code):
    return COUNTRY_NAMES.get(code, code or '')


def location_role(role):
    """Map a TankBazaar facility role to owner / operator / owner-operator (None = not an owner or operator)."""
    r = (role or '').lower()
    own = r.startswith('owner') or r.startswith('group parent') or r.startswith('partner')
    op = 'operator' in r
    if own and op:
        return 'owner-operator'
    if op:
        return 'operator'
    if own:
        return 'owner'
    return None


def facility_categories(t):
    """Category slugs (T3 section 12 tree) for one facility record."""
    cats = []
    cls = t.get('facilityClass') or []
    if 'storage' in cls or not cls:
        cats.append('storage-terminals')
    pts = [p for p in (t.get('processType') or []) if p in PROCESS_LABEL]
    if 'process' in cls or pts:
        cats.append('process-industries')
        cats.extend(pts)
    return cats


def _count_phrase(n, labels):
    return f"{n} {labels[0] if n == 1 else labels[1]}" if n > 1 else f"one {labels[0]}"


def describe(name, facilities, child_names, country):
    """Short public description built only from the facility records (no notes, no sources).
    facilities: list of (role, terminal record); child_names: names of subsidiaries in TankBazaar."""
    if facilities:
        storage = other = 0
        floating = sum(1 for _, t in facilities if t.get('type') == 'floating')
        proc = {}
        for _, t in facilities:
            pts = [p for p in (t.get('processType') or []) if p in PROCESS_LABEL]
            for p in pts:
                proc[p] = proc.get(p, 0) + 1
            if not pts:
                if 'storage' in (t.get('facilityClass') or ['storage']):
                    storage += 1
                else:
                    other += 1
        parts = []
        if storage:
            parts.append(_count_phrase(storage, ('storage terminal', 'storage terminals')))
        for p, n in sorted(proc.items(), key=lambda x: -x[1]):
            parts.append(_count_phrase(n, PROCESS_LABEL[p]))
        if other:
            parts.append(_count_phrase(other, ('processing facility', 'processing facilities')))
        roles = {location_role(r) for r, _ in facilities}
        raw = [(r or '').lower() for r, _ in facilities]
        if 'owner-operator' in roles or ('owner' in roles and 'operator' in roles):
            verb = 'Owns and operates'
        elif 'operator' in roles:
            verb = 'Operates'
        elif all(x.startswith('group parent') for x in raw):
            verb = 'Owns, through subsidiaries,'
        elif any('%' in x or 'partner' in x or 'interest' in x for x in raw):
            verb = 'Holds interests in'
        else:
            verb = 'Owns'
        countries = sorted({country_name(country_code(t.get('country'))) for _, t in facilities if country_code(t.get('country'))})
        where = ''
        if len(countries) == 1:
            where = ' in ' + countries[0]
        elif 1 < len(countries) <= 3:
            where = ' in ' + ', '.join(countries[:-1]) + ' and ' + countries[-1]
        elif len(countries) > 3:
            where = f' in {len(countries)} countries'
        listed = ', '.join(parts[:-1]) + ' and ' + parts[-1] if len(parts) > 1 else parts[0]
        s = f"{verb} {listed}{where}"
        if floating:
            s += f", including {'one floating facility' if floating == 1 else str(floating) + ' floating facilities'}"
        return s + '.'
    if child_names:
        k = len(child_names)
        eg = ', '.join(sorted(child_names)[:3])
        return f"Parent company of {k} {'company' if k == 1 else 'companies'} in the TankBazaar register, including {eg}."
    cn = country_name(country)
    return f"Company in the oil, gas and chemical storage and processing sector{(' based in ' + cn) if cn else ''}."


def add_pipelines(desc, facilities, pipes):
    """Extend a company description with the pipelines it owns or operates (pipes: pipeline records)."""
    if not pipes:
        return desc
    phrase = _count_phrase(len(pipes), PIPE_LABEL)
    if facilities:
        return desc[:-1] + f', and owns or operates {phrase}.'
    pcs = sorted({country_name(p.get('cc')) for p in pipes if p.get('cc')})
    where = (' in ' + pcs[0]) if len(pcs) == 1 else (f' in {len(pcs)} countries' if len(pcs) > 1 else '')
    return f'Owns or operates {phrase}{where}.'
