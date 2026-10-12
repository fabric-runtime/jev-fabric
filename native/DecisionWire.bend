import Base
import ./Codec.bend as Codec
import ./Wire.bend as W
import ./DecisionGenerated.bend as Generated
import ./vendor/strict-json/json.bend as J

# Pure protocol code. Routing, credentials and capability policy belong to the host.
def Error() -> Type:
  U32 & String

def bytes_max() -> U32:
  16777216

def kind_tag(value: String, tag: U32) -> String:
  match tag:
    case 1: "boolean"
    case 2: "boolean"
    case 3: "boolean"
    case unmatched: value

def kind(+value: String) -> String:
  kind_tag(value, Bool.pick(U32, String.eq(value, "bool"), 1, Bool.pick(U32, String.eq(value, "noul"), 2, Bool.pick(U32, String.eq(value, "predicate"), 3, 0))))

def clean(s: String) -> Bool:
  match s:
    case SNil{}: True{}
    case SCon{Chr{+c}, tail}:
      U32.is_ge(c, 32) && Bool.not(U32.is_eq(c, 127)) && clean(tail)

def identifier(+s: String, limit: Nat) -> Bool:
  W.label(s, limit) && clean(s)

# Model maxLength follows JSON Schema Unicode scalars, unlike protocol labels.
def optional_model(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{J.Str{+text}}:
      Codec.guard(Bool.not(String.is_empty(text)) && Nat.is_le(String.length(text), 256n) && clean(text), "Invalid decision target model")
    case other: Fail{(22, "Decision model must be a string")}

def optional_string(value: Maybe<&2, J.JSON>, limit: Nat) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{v}:
      do Result<&1, &1, Error, Unit>:
        s : String <- W.string(v)
        Codec.guard(identifier(s, limit), "invalid decision label")

# Shared structural profile names; validation never loads profile configuration.
def profile_chars(text: String) -> Bool:
  match text:
    case SNil{}: True{}
    case SCon{c, rest}:
      +n = Char.to_u32(c)
      ((U32.is_ge(n, 65) && U32.is_le(n, 90)) ||
        (U32.is_ge(n, 97) && U32.is_le(n, 122)) ||
        (U32.is_ge(n, 48) && U32.is_le(n, 57)) ||
        U32.is_eq(n, 95) || U32.is_eq(n, 46) || U32.is_eq(n, 45)) && profile_chars(rest)

def profile_name(+text: String) -> Bool:
  Bool.not(String.is_empty(text)) && Nat.is_le(String.length(text), 128n) && profile_chars(text) &&
    Bool.not(Codec.contains(["__proto__", "prototype", "constructor"], text))

def optional_profile(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{J.Str{text}}: Codec.guard(profile_name(text), "Invalid decision profile name")
    case other: Fail{(22, "Decision profile must be a string")}

def optional_bool(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{J.Boolean{b}}: Done{Unit{}}
    case other: Fail{(22, "expected boolean option")}

def optional_temperature(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{v}:
      do Result<&1, &1, Error, Unit>:
        checked : W.Decimal <- W.decimal(v, 2n)
        return Unit{}

def option_namespaces(fields: List<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match fields:
    case Nil{}: Done{Unit{}}
    case Con{J.Member{name, value}, tail}:
      do Result<&1, &1, Error, Unit>:
        Codec.guard(identifier(name, 128n), "invalid provider option namespace")
        entries : List<&2, J.JSON> <- W.object(value)
        option_namespaces(tail)
    case other: Fail{(22, "invalid provider options")}

def options(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{v}:
      do Result<&1, &1, Error, Unit>:
        fields : List<&2, J.JSON> <- W.object(v)
        return Unit{}

# Strict RFC 4648 alphabet and canonical padding; no URLs or whitespace.
def base64_digit(+c: U32) -> Bool:
  (U32.is_ge(c, 65) && U32.is_le(c, 90))
    || (U32.is_ge(c, 97) && U32.is_le(c, 122))
    || (U32.is_ge(c, 48) && U32.is_le(c, 57))
    || U32.is_eq(c, 43) || U32.is_eq(c, 47)

def base64_tail2(c: Char) -> Bool:
  Codec.contains(["A", "Q", "g", "w"], SCon{c, SNil{}})

def base64_tail3(c: Char) -> Bool:
  Codec.contains(["A", "E", "I", "M", "Q", "U", "Y", "c", "g", "k", "o", "s", "w", "0", "4", "8"], SCon{c, SNil{}})

def base64(s: String) -> Bool:
  match s:
    case SNil{}: True{}
    case SCon{Chr{a}, SCon{+b, SCon{'=', SCon{'=', SNil{}}}}}:
      base64_digit(a) && base64_tail2(b)
    case SCon{Chr{a}, SCon{Chr{b}, SCon{c, SCon{'=', SNil{}}}}}:
      base64_digit(a) && base64_digit(b) && base64_tail3(c)
    case SCon{Chr{a}, SCon{Chr{b}, SCon{Chr{c}, SCon{Chr{d}, tail}}}}:
      base64_digit(a) && base64_digit(b) && base64_digit(c) && base64_digit(d) && base64(tail)
    case other: False{}

def image_type(value: Maybe<&2, J.JSON>) -> Bool:
  match value:
    case None{}: True{}
    case Some{J.Str{s}}: String.eq(s, "image")
    case other: False{}

def images(items: List<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match items:
    case Nil{}: Done{Unit{}}
    case Con{+image, tail}:
      do Result<&1, &1, Error, Unit>:
        fields : List<&2, J.JSON> <- W.object(image)
        Codec.guard(W.only(fields, ["type", "data", "mimeType"]), "unknown image field")
        Codec.guard(image_type(Codec.field(image, "type")), "invalid image type")
        data_value : J.JSON <- W.need(image, "data")
        +data : String <- W.string(data_value)
        Codec.guard(Bool.not(String.is_empty(data)) && base64(data), "invalid image base64")
        mime_value : J.JSON <- W.need(image, "mimeType")
        mime : String <- W.string(mime_value)
        Codec.guard(Codec.contains(["image/png", "image/jpeg", "image/webp", "image/gif"], mime), "invalid image MIME type")
        images(tail)

def optional_images(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{v}:
      do Result<&1, &1, Error, Unit>:
        +items : List<&2, J.JSON> <- W.array(v)
        Codec.guard(Nat.is_le(List.length(&2, J.JSON, items), 128n), "too many images")
        images(items)

def question_kind_tag(k: String, q: J.JSON, tag: U32) -> Result<&1, &1, Error, Unit>:
  match tag:
    case 1: W.noul_criteria(Codec.field(q, "criteria"))
    case unmatched: W.question_kind(k, q)

def question_kind(+k: String, q: J.JSON) -> Result<&1, &1, Error, Unit>:
  question_kind_tag(k, q, Bool.pick(U32, String.eq(k, "boolean"), 1, 0))

def question(+q: J.JSON) -> Result<&1, &1, Error, Unit>:
  do Result<&1, &1, Error, Unit>:
    fields : List<&2, J.JSON> <- W.object(q)
    Codec.guard(W.only(fields, ["type", "instructions", "criteria"]), "unknown question field")
    instruction : J.JSON <- W.need(q, "instructions")
    Codec.guard(W.description(instruction), "invalid instructions")
    type_value : J.JSON <- W.need(q, "type")
    type_text : String <- W.string(type_value)
    question_kind(kind(type_text), q)

def questions(fields: List<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match fields:
    case Nil{}: Done{Unit{}}
    case Con{J.Member{id, q}, tail}:
      do Result<&1, &1, Error, Unit>:
        Codec.guard(identifier(id, 128n), "invalid question id")
        question(q)
        questions(tail)
    case other: Fail{(22, "invalid questions")}

def validate_request(+value: J.JSON) -> Result<&1, &1, Error, J.JSON>:
  do Result<&1, &1, Error, J.JSON>:
    checked : J.JSON <- Codec.validate_with_limit(value, bytes_max())
    fields : List<&2, J.JSON> <- W.object(checked)
    Codec.guard(W.only(fields, ["state", "questions", "images", "model", "provider", "profile", "api", "endpoint", "allowLocal", "allowGenerated", "providerOptions", "temperature"]), "unknown decision request field")
    state : J.JSON <- W.need(value, "state")
    Codec.guard(W.description(state), "invalid decision state")
    qs : J.JSON <- W.need(value, "questions")
    +qfields : List<&2, J.JSON> <- W.object(qs)
    +n : Nat = List.length(&2, J.JSON, qfields)
    Codec.guard(Nat.is_ge(n, 1n) && Nat.is_le(n, 128n), "invalid question count")
    questions(qfields)
    optional_model(Codec.field(value, "model"))
    optional_string(Codec.field(value, "provider"), 128n)
    optional_profile(Codec.field(value, "profile"))
    optional_string(Codec.field(value, "api"), 128n)
    optional_string(Codec.field(value, "endpoint"), 4096n)
    optional_bool(Codec.field(value, "allowLocal"))
    optional_bool(Codec.field(value, "allowGenerated"))
    optional_temperature(Codec.field(value, "temperature"))
    options(Codec.field(value, "providerOptions"))
    optional_images(Codec.field(value, "images"))
    return value

def request(text: String) -> Result<&1, &1, Error, J.JSON>:
  do Result<&1, &1, Error, J.JSON>:
    value : J.JSON <- Codec.read_with_limit(text, bytes_max())
    validate_request(value)

def optional_member(key: String, value: Maybe<&2, J.JSON>) -> List<&2, J.JSON>:
  match value:
    case None{}: Nil{}
    case Some{v}: [J.Member{key, v}]

def no_option(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case other: Fail{(22, "option unsupported by decision API")}

def text(value: J.JSON) -> Result<&1, &1, Error, String>:
  match value:
    case J.Str{s}: Done{s}
    case other: Codec.encode_with_limit(other, bytes_max())

def boolean_wire_kind_tag(api: String, tag: U32) -> String:
  match tag:
    case 1: "noul"
    case 2: "noul"
    case 3: "noul"
    case 4: "predicate"
    case unmatched: "boolean"

def boolean_wire_kind(+api: String) -> String:
  boolean_wire_kind_tag(api, Bool.pick(U32, String.eq(api, "system-one"), 1, Bool.pick(U32, String.eq(api, "llama-system-one"), 2, Bool.pick(U32, String.eq(api, "cloudflare"), 3, Bool.pick(U32, String.eq(api, "openai-decisions"), 4, 0)))))

def wire_kind_tag(k: String, api: String, tag: U32) -> String:
  match tag:
    case 1: boolean_wire_kind(api)
    case unmatched: k

def wire_kind(+k: String, api: String) -> String:
  wire_kind_tag(k, api, Bool.pick(U32, String.eq(k, "boolean"), 1, 0))

def standard_questions(fields: List<&2, J.JSON>, +api: String) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match fields:
    case Nil{}: Done{Nil{}}
    case Con{J.Member{id, +q}, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        type_value : J.JSON <- W.need(q, "type")
        type_text : String <- W.string(type_value)
        instruction : J.JSON <- W.need(q, "instructions")
        extras : List<&2, J.JSON> = optional_member("criteria", Codec.field(q, "criteria"))
        safe : J.JSON = J.Obj{Con{J.Member{"type", J.Str{wire_kind(kind(type_text), api)}}, Con{J.Member{"instructions", instruction}, extras}}}
        rest : List<&2, J.JSON> <- standard_questions(tail, api)
        return Con{J.Member{id, safe}, rest}
    case other: Fail{(22, "invalid questions")}

def choice_description(value: J.JSON) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match value:
    case J.Null{}: Done{Nil{}}
    case other:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        description : String <- text(other)
        return [J.Member{"description", J.Str{description}}]

def openai_choices(fields: List<&2, J.JSON>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match fields:
    case Nil{}: Done{Nil{}}
    case Con{J.Member{id, description}, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        extra : List<&2, J.JSON> <- choice_description(description)
        rest : List<&2, J.JSON> <- openai_choices(tail)
        return Con{J.Obj{Con{J.Member{"value", J.Str{id}}, extra}}, rest}
    case other: Fail{(22, "invalid choices")}

def openai_levels(items: List<&2, J.JSON>, +index: Nat) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match items:
    case Nil{}: Done{Nil{}}
    case Con{item, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        description : String <- text(item)
        rest : List<&2, J.JSON> <- openai_levels(tail, 1n+index)
        return Con{J.Obj{[J.Member{"label", J.Str{Nat.show(index)}}, J.Member{"description", J.Str{description}}]}, rest}

def openai_criteria_tag(k: String, q: J.JSON, tag: U32) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match tag:
    case 1:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        c : J.JSON <- W.need(q, "criteria")
        fields : List<&2, J.JSON> <- W.object(c)
        choices : List<&2, J.JSON> <- openai_choices(fields)
        return [J.Member{"choices", J.Arr{choices}}]
    case 2:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        c : J.JSON <- W.need(q, "criteria")
        items : List<&2, J.JSON> <- W.array(c)
        levels : List<&2, J.JSON> <- openai_levels(items, 0n)
        return [J.Member{"levels", J.Arr{levels}}]
    case unmatched: Done{Nil{}}

# Predicate has no criteria slot. Encode the structured criteria into its instructions.
def openai_criteria(+k: String, q: J.JSON) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  openai_criteria_tag(k, q, Bool.pick(U32, String.eq(k, "choice"), 1, Bool.pick(U32, String.eq(k, "score"), 2, 0)))

def predicate_instruction(instruction: J.JSON, criteria: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, String>:
  match criteria:
    case Some{c}: text(J.Obj{[J.Member{"instructions", instruction}, J.Member{"criteria", c}]})
    case None{}: text(instruction)

def instruction_for(instruction: J.JSON, criteria: Maybe<&2, J.JSON>, predicate: Bool) -> Result<&1, &1, Error, String>:
  match predicate:
    case True{}: predicate_instruction(instruction, criteria)
    case False{}: text(instruction)

def openai_instruction(instruction: J.JSON, k: String, criteria: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, String>:
  instruction_for(instruction, criteria, String.eq(k, "boolean"))

def openai_questions(fields: List<&2, J.JSON>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match fields:
    case Nil{}: Done{Nil{}}
    case Con{J.Member{id, +q}, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        type_value : J.JSON <- W.need(q, "type")
        type_text : String <- W.string(type_value)
        +k : String = kind(type_text)
        instruction : J.JSON <- W.need(q, "instructions")
        instructions : String <- openai_instruction(instruction, k, Codec.field(q, "criteria"))
        extra : List<&2, J.JSON> <- openai_criteria(k, q)
        safe : J.JSON = J.Obj{Con{J.Member{"name", J.Str{id}}, Con{J.Member{"type", J.Str{wire_kind(k, "openai-decisions")}}, Con{J.Member{"instructions", J.Str{instructions}}, extra}}}}
        rest : List<&2, J.JSON> <- openai_questions(tail)
        return Con{safe, rest}
    case other: Fail{(22, "invalid questions")}

def image_parts(items: List<&2, J.JSON>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match items:
    case Nil{}: Done{Nil{}}
    case Con{+image, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        d : J.JSON <- W.need(image, "data")
        data : String <- W.string(d)
        m : J.JSON <- W.need(image, "mimeType")
        mime : String <- W.string(m)
        rest : List<&2, J.JSON> <- image_parts(tail)
        return Con{J.Obj{[J.Member{"type", J.Str{"input_image"}}, J.Member{"image_url", J.Str{"data:" ++ mime ++ ";base64," ++ data}}]}, rest}

def openai_input(state: String, images: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, J.JSON>:
  match images:
    case None{}: Done{J.Str{state}}
    case Some{v}:
      do Result<&1, &1, Error, J.JSON>:
        items : List<&2, J.JSON> <- W.array(v)
        parts : List<&2, J.JSON> <- image_parts(items)
        content : J.JSON = J.Arr{Con{J.Obj{[J.Member{"type", J.Str{"input_text"}}, J.Member{"text", J.Str{state}}]}, parts}}
        return J.Arr{[J.Obj{[J.Member{"role", J.Str{"user"}}, J.Member{"content", content}]}]}

def no_images(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{J.Arr{Nil{}}}: Done{Unit{}}
    case other: Fail{(22, "images unsupported by decision API")}

# Official Workers AI Clef schema: flat model/state/questions/images body.
# https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json
def cloudflare_model_tag(model: String, tag: U32) -> Result<&1, &1, Error, String>:
  match tag:
    case 1: Done{"clef"}
    case 2: Done{"clef-flash"}
    case 3: Done{"clef"}
    case 4: Done{"clef-flash"}
    case unmatched: Fail{(22, "unsupported Cloudflare decision model")}

def cloudflare_model(+model: String) -> Result<&1, &1, Error, String>:
  cloudflare_model_tag(model, Bool.pick(U32, String.eq(model, "@cf/cloudflare/clef"), 1, Bool.pick(U32, String.eq(model, "@cf/cloudflare/clef-flash"), 2, Bool.pick(U32, String.eq(model, "clef"), 3, Bool.pick(U32, String.eq(model, "clef-flash"), 4, 0)))))

def cloudflare_id(s: String) -> Bool:
  match s:
    case SNil{}: True{}
    case SCon{Chr{+c}, tail}:
      ((U32.is_ge(c, 65) && U32.is_le(c, 90))
        || (U32.is_ge(c, 97) && U32.is_le(c, 122))
        || (U32.is_ge(c, 48) && U32.is_le(c, 57))
        || U32.is_eq(c, 95) || U32.is_eq(c, 46) || U32.is_eq(c, 45)) && cloudflare_id(tail)

def cloudflare_instruction(value: J.JSON) -> Bool:
  match value:
    case J.Str{s}: Bool.not(String.is_empty(s))
    case other: W.description(other)

def cloudflare_choice_tag(q: J.JSON, k: String, tag: U32) -> Result<&1, &1, Error, Unit>:
  match tag:
    case 1:
      do Result<&1, &1, Error, Unit>:
        c : J.JSON <- W.need(q, "criteria")
        fields : List<&2, J.JSON> <- W.object(c)
        Codec.guard(Nat.is_ge(List.length(&2, J.JSON, fields), 2n), "Cloudflare choice requires two options")
    case unmatched: Done{Unit{}}

def cloudflare_choice(q: J.JSON, +k: String) -> Result<&1, &1, Error, Unit>:
  cloudflare_choice_tag(q, k, Bool.pick(U32, String.eq(k, "choice"), 1, 0))

def cloudflare_questions(fields: List<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match fields:
    case Nil{}: Done{Unit{}}
    case Con{J.Member{+id, +q}, tail}:
      do Result<&1, &1, Error, Unit>:
        Codec.guard(W.label(id, 100n) && cloudflare_id(id), "invalid Cloudflare question id")
        instruction : J.JSON <- W.need(q, "instructions")
        Codec.guard(cloudflare_instruction(instruction), "invalid Cloudflare instructions")
        t : J.JSON <- W.need(q, "type")
        k : String <- W.string(t)
        cloudflare_choice(q, k)
        cloudflare_questions(tail)
    case other: Fail{(22, "invalid Cloudflare questions")}

def base64_padding(reversed: String) -> Nat:
  match reversed:
    case SCon{'=', SCon{'=', tail}}: 2n
    case SCon{'=', tail}: 1n
    case other: 0n

def decoded_bytes(+data: String) -> Nat:
  Nat.sub(Nat.mul(Nat.div(String.length(data), 4n), 3n), base64_padding(String.reverse(data)))

# Clef and SubQ Snap take the same inline images under the same limits (at most
# 4; PNG, JPEG or WebP; 4 MiB decoded each, 8 MiB in total). Only the name of
# the media-type key differs: `content_type` and `mediaType`.
def flat_image_rows(items: List<&2, J.JSON>, +remaining: Nat, +type_key: String, +label: String) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match items:
    case Nil{}: Done{Nil{}}
    case Con{+image, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        d : J.JSON <- W.need(image, "data")
        +data : String <- W.string(d)
        m : J.JSON <- W.need(image, "mimeType")
        +mime : String <- W.string(m)
        Codec.guard(Codec.contains(["image/png", "image/jpeg", "image/webp"], mime), "unsupported " ++ label ++ " image MIME")
        +n : Nat = decoded_bytes(data)
        Codec.guard(Nat.is_le(n, 4194304n) && Nat.is_le(n, remaining), label ++ " decoded image byte limit")
        rest : List<&2, J.JSON> <- flat_image_rows(tail, Nat.sub(remaining, n), type_key, label)
        return Con{J.Obj{[J.Member{type_key, J.Str{mime}}, J.Member{"base64", J.Str{data}}]}, rest}

def flat_images(value: Maybe<&2, J.JSON>, type_key: String, +label: String) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match value:
    case None{}: Done{Nil{}}
    case Some{v}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        +items : List<&2, J.JSON> <- W.array(v)
        Codec.guard(Nat.is_le(List.length(&2, J.JSON, items), 4n), label ++ " image count limit")
        rows : List<&2, J.JSON> <- flat_image_rows(items, 8388608n, type_key, label)
        return [J.Member{"images", J.Arr{rows}}]

def cloudflare_image_rows(items: List<&2, J.JSON>, remaining: Nat) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  flat_image_rows(items, remaining, "content_type", "Cloudflare")

def cloudflare_images(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  flat_images(value, "content_type", "Cloudflare")

def clef_body(state: J.JSON, +qs: List<&2, J.JSON>, +req: J.JSON, model: String) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    no_option(Codec.field(req, "providerOptions"))
    selector : String <- cloudflare_model(model)
    Codec.guard(Nat.is_le(List.length(&2, J.JSON, qs), 64n), "Cloudflare question count limit")
    cloudflare_questions(qs)
    questions : List<&2, J.JSON> <- standard_questions(qs, "cloudflare")
    imgs : List<&2, J.JSON> <- cloudflare_images(Codec.field(req, "images"))
    Codec.encode_with_limit(J.Obj{List.append(&2, J.JSON, [J.Member{"model", J.Str{selector}}, J.Member{"state", state}, J.Member{"questions", J.Obj{questions}}], imgs)}, 13631488)

def cloudflare_wrapped(state: J.JSON, qs: List<&2, J.JSON>, +req: J.JSON, model: String) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    no_images(Codec.field(req, "images"))
    no_option(Codec.field(req, "providerOptions"))
    questions : List<&2, J.JSON> <- standard_questions(qs, "cloudflare")
    input : J.JSON = J.Obj{[J.Member{"state", state}, J.Member{"questions", J.Obj{questions}}]}
    Codec.encode_with_limit(J.Obj{[J.Member{"model", J.Str{model}}, J.Member{"input", input}]}, bytes_max())

def cloudflare_dispatch(state: J.JSON, qs: List<&2, J.JSON>, req: J.JSON, model: String, clef: Bool) -> Result<&1, &1, Error, String>:
  match clef:
    case True{}: clef_body(state, qs, req, model)
    case False{}: cloudflare_wrapped(state, qs, req, model)

def cloudflare_body(state: J.JSON, qs: List<&2, J.JSON>, req: J.JSON, +model: String) -> Result<&1, &1, Error, String>:
  cloudflare_dispatch(state, qs, req, model, Codec.contains(["clef", "clef-flash", "@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"], model))

# llama.cpp's native /v1/systemone accepts images as inline data URL strings.
def llama_images(items: List<&2, J.JSON>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match items:
    case Nil{}: Done{Nil{}}
    case Con{+image, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        d : J.JSON <- W.need(image, "data")
        data : String <- W.string(d)
        m : J.JSON <- W.need(image, "mimeType")
        mime : String <- W.string(m)
        rest : List<&2, J.JSON> <- llama_images(tail)
        return Con{J.Str{"data:" ++ mime ++ ";base64," ++ data}, rest}

def llama_image_member(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match value:
    case None{}: Done{Nil{}}
    case Some{v}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        items : List<&2, J.JSON> <- W.array(v)
        imgs : List<&2, J.JSON> <- llama_images(items)
        return [J.Member{"images", J.Arr{imgs}}]

def llama_body(state: J.JSON, qs: List<&2, J.JSON>, +req: J.JSON, model: String) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    no_option(Codec.field(req, "providerOptions"))
    questions : List<&2, J.JSON> <- standard_questions(qs, "llama-system-one")
    imgs : List<&2, J.JSON> <- llama_image_member(Codec.field(req, "images"))
    Codec.encode_with_limit(J.Obj{List.append(&2, J.JSON, [J.Member{"model", J.Str{model}}, J.Member{"state", state}, J.Member{"questions", J.Obj{questions}}], imgs)}, bytes_max())

def provider_name(value: Maybe<&2, J.JSON>) -> String:
  match value:
    case Some{J.Str{s}}: s
    case other: ""

def provider_option_key_tag(provider: String, tag: U32) -> Result<&1, &1, Error, String>:
  match tag:
    case 1: Done{"provider"}
    case 2: Done{"providerOptions"}
    case 3: Done{"providerOptions"}
    case 4: Done{"providerOptions"}
    case unmatched: Fail{(22, "providerOptions unsupported by decision provider")}

def provider_option_key(+provider: String) -> Result<&1, &1, Error, String>:
  provider_option_key_tag(provider, Bool.pick(U32, String.eq(provider, "openrouter"), 1, Bool.pick(U32, String.eq(provider, "vercel"), 2, Bool.pick(U32, String.eq(provider, "vercel-evaluate"), 3, Bool.pick(U32, String.eq(provider, "vercel-decisions"), 4, 0)))))

def standard_option_key_tag(provider: String, api: String, tag: U32) -> Result<&1, &1, Error, String>:
  match tag:
    case 1: Done{"providerOptions"}
    case unmatched: provider_option_key(provider)

def standard_option_key(provider: String, +api: String) -> Result<&1, &1, Error, String>:
  standard_option_key_tag(provider, api, Bool.pick(U32, String.eq(api, "vercel-evaluate"), 1, 0))

def standard_options(value: Maybe<&2, J.JSON>, provider: String, api: String) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match value:
    case None{}: Done{Nil{}}
    case Some{v}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        key : String <- standard_option_key(provider, api)
        return [J.Member{key, v}]

def safety_identifier(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Unit>:
  match value:
    case None{}: Done{Unit{}}
    case Some{J.Null{}}: Done{Unit{}}
    case other: optional_string(other, 64n)

def openai_direct_options(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match value:
    case None{}: Done{Nil{}}
    case Some{+v}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        +fields : List<&2, J.JSON> <- W.object(v)
        Codec.guard(W.only(fields, ["safety_identifier"]), "unsupported OpenAI decision option")
        safety_identifier(Codec.field(v, "safety_identifier"))
        return fields

def openai_options_tag(value: Maybe<&2, J.JSON>, provider: String, tag: U32) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match tag:
    case 1: Done{optional_member("providerOptions", value)}
    case unmatched: openai_direct_options(value)

def openai_options(value: Maybe<&2, J.JSON>, +provider: String) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  openai_options_tag(value, provider, Bool.pick(U32, String.eq(provider, "vercel-decisions"), 1, 0))

# SubQ's SystemOne documents inline images and a 13 MiB request body:
# https://docs.subq.ai/endpoints/decisions-api/#images
# The other SystemOne routes document no image shape, so they take none.
def system_one_images(value: Maybe<&2, J.JSON>, subq: Bool) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match subq:
    case True{}: flat_images(value, "mediaType", "SubQ")
    case False{}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        no_images(value)
        return Nil{}

def system_one_bytes(subq: Bool) -> U32:
  match subq:
    case True{}: 13631488
    case False{}: bytes_max()

def model_extras(model: String, extras: Result<&1, &1, Error, List<&2, J.JSON>>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match extras:
    case Fail{e}: Fail{e}
    case Done{fields}: Done{Con{J.Member{"model", J.Str{model}}, fields}}

def native_extras(+req: J.JSON, api: String, model: String) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  model_extras(model, standard_options(Codec.field(req, "providerOptions"), provider_name(Codec.field(req, "provider")), api))


def native_body_for_tag(state: J.JSON, qs: List<&2, J.JSON>, +req: J.JSON, +api: String, model: String, tag: U32) -> Result<&1, &1, Error, String>:
  match tag:
    case 1: cloudflare_body(state, qs, req, model)
    case 2: llama_body(state, qs, req, model)
    case 3:
      do Result<&1, &1, Error, String>:
        extras : List<&2, J.JSON> <- openai_options(Codec.field(req, "providerOptions"), provider_name(Codec.field(req, "provider")))
        state_text : String <- text(state)
        input : J.JSON <- openai_input(state_text, Codec.field(req, "images"))
        questions : List<&2, J.JSON> <- openai_questions(qs)
        Codec.encode_with_limit(J.Obj{List.append(&2, J.JSON, [J.Member{"model", J.Str{model}}, J.Member{"input", input}, J.Member{"questions", J.Arr{questions}}], extras)}, bytes_max())
    case unmatched:
      do Result<&1, &1, Error, String>:
        Codec.guard(Codec.contains(["system-one", "vercel-evaluate"], api), "unsupported decision API")
        +subq : Bool = String.eq(api, "system-one") && String.eq(provider_name(Codec.field(req, "provider")), "subq")
        imgs : List<&2, J.JSON> <- system_one_images(Codec.field(req, "images"), subq)
        questions : List<&2, J.JSON> <- standard_questions(qs, api)
        extras : List<&2, J.JSON> <- native_extras(req, api, model)
        Codec.encode_with_limit(J.Obj{Con{J.Member{"state", state}, Con{J.Member{"questions", J.Obj{questions}}, List.append(&2, J.JSON, extras, imgs)}}}, system_one_bytes(subq))

def native_body_for(state: J.JSON, qs: List<&2, J.JSON>, +req: J.JSON, +api: String, model: String) -> Result<&1, &1, Error, String>:
  native_body_for_tag(state, qs, req, api, model, Bool.pick(U32, String.eq(api, "cloudflare"), 1, Bool.pick(U32, String.eq(api, "llama-system-one"), 2, Bool.pick(U32, String.eq(api, "openai-decisions"), 3, 0))))

def native_body(+req: J.JSON, +api: String, model: String) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    no_option(Codec.field(req, "temperature"))
    state : J.JSON <- W.need(req, "state")
    qs : J.JSON <- W.need(req, "questions")
    qfields : List<&2, J.JSON> <- W.object(qs)
    native_body_for(state, qfields, req, api, model)

def option_fields(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match value:
    case None{}: Done{Nil{}}
    case Some{v}: W.object(v)

def generated_temperature(+fields: List<&2, J.JSON>, temperature: Maybe<&2, J.JSON>, api: String) -> Result<&1, &1, Error, J.JSON>:
  match temperature:
    case None{}: Done{J.Obj{fields}}
    case Some{t}:
      do Result<&1, &1, Error, J.JSON>:
        Codec.guard(String.eq(api, "google"), "temperature unsupported by decision API")
        Codec.guard(Bool.not(W.named(fields, "temperature")), "duplicate temperature option")
        return J.Obj{Con{J.Member{"temperature", t}, fields}}

def generated_options(value: Maybe<&2, J.JSON>, temperature: Maybe<&2, J.JSON>, +api: String) -> Result<&1, &1, Error, J.JSON>:
  do Result<&1, &1, Error, J.JSON>:
    fields : List<&2, J.JSON> <- option_fields(value)
    generated_temperature(fields, temperature, api)

def generated_body(+req: J.JSON, +api: String, +model: String) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    state : J.JSON <- W.need(req, "state")
    qs : J.JSON <- W.need(req, "questions")
    opts : J.JSON <- generated_options(Codec.field(req, "providerOptions"), Codec.field(req, "temperature"), api)
    imgs : List<&2, J.JSON> = optional_member("images", Codec.field(req, "images"))
    projected : J.JSON = J.Obj{List.append(&2, J.JSON, [J.Member{"state", state}, J.Member{"questions", qs}, J.Member{"model", J.Str{model}}, J.Member{"providerOptions", opts}], imgs)}
    Generated.body(projected, api, model)

def body_for_tag(req: J.JSON, api: String, model: String, tag: U32) -> Result<&1, &1, Error, String>:
  match tag:
    case 1: generated_body(req, "anthropic", model)
    case 2: generated_body(req, "google", model)
    case unmatched: native_body(req, api, model)

def body_for(req: J.JSON, +api: String, model: String) -> Result<&1, &1, Error, String>:
  body_for_tag(req, api, model, Bool.pick(U32, String.eq(api, "anthropic"), 1, Bool.pick(U32, String.eq(api, "google"), 2, 0)))

def body(value: J.JSON, +api: String, +model: String) -> Result<&1, &1, Error, String>:
  do Result<&1, &1, Error, String>:
    checked : J.JSON <- validate_request(value)
    optional_model(Some{J.Str{model}})
    body_for(checked, api, model)

# Missing usage is deliberately distinct from zero usage; malformed partial usage fails.
def count(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, Maybe<&2, Nat>>:
  match value:
    case None{}: Done{None{}}
    case Some{J.Null{}}: Done{None{}}
    case Some{v}:
      do Result<&1, &1, Error, Maybe<&2, Nat>>:
        n : Nat <- W.scalar(v, 0n, W.nat_max())
        return Some{n}

def counts_pair(input: Maybe<&2, Nat>, output: Maybe<&2, Nat>) -> Maybe<&1, Nat & Nat>:
  match input output:
    case Some{i} Some{o}: Some{(i, o)}
    case _ _: None{}

def usage_counts(+u: J.JSON, input_key: String, output_key: String) -> Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
  do Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
    fields : List<&2, J.JSON> <- W.object(u)
    i : Maybe<&2, Nat> <- count(Codec.field(u, input_key))
    o : Maybe<&2, Nat> <- count(Codec.field(u, output_key))
    return counts_pair(i, o)

def maybe_usage(value: Maybe<&2, J.JSON>, i: String, o: String) -> Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
  match value:
    case None{}: Done{None{}}
    case Some{J.Null{}}: Done{None{}}
    case Some{u}: usage_counts(u, i, o)

def reported_usage(value: J.JSON) -> Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
  do Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
    +checked : J.JSON <- Codec.validate_with_limit(value, bytes_max())
    fields : List<&2, J.JSON> <- W.object(checked)
    maybe_usage(Codec.field(checked, "usage"), "input_tokens", "output_tokens")

def cloudflare_nested(value: J.JSON, state: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, J.JSON>:
  match state:
    case None{}: Done{value}
    case Some{J.Str{state}}:
      do Result<&1, &1, Error, J.JSON>:
        Codec.guard(String.eq(state, "Completed"), "Cloudflare decision not completed")
        W.need(value, "result")
    case other: Fail{(22, "Cloudflare decision not completed")}

def cloudflare_result(+value: J.JSON) -> Result<&1, &1, Error, J.JSON>:
  do Result<&1, &1, Error, J.JSON>:
    +result : J.JSON <- W.need(value, "result")
    cloudflare_nested(result, Codec.field(result, "state"))

def raw_counts_tag(value: J.JSON, api: String, tag: U32) -> Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
  match tag:
    case 1:
      do Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
        unwrapped : J.JSON <- cloudflare_result(value)
        maybe_usage(Codec.field(unwrapped, "usage"), "input_tokens", "output_tokens")
    case 2: maybe_usage(Codec.field(value, "usage"), "inputTokens", "outputTokens")
    case 3:
      do Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
        u : J.JSON <- Generated.raw_usage(value, "google")
        usage_counts(u, "input_tokens", "output_tokens")
    case 4:
      do Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
        u : J.JSON <- Generated.raw_usage(value, "anthropic")
        usage_counts(u, "input_tokens", "output_tokens")
    case 5: maybe_usage(Codec.field(value, "usage"), "input_tokens", "output_tokens")
    case 6: maybe_usage(Codec.field(value, "usage"), "input_tokens", "output_tokens")
    case 7: maybe_usage(Codec.field(value, "usage"), "input_tokens", "output_tokens")
    case unmatched: Fail{(22, "unsupported decision API")}

def raw_counts(value: J.JSON, +api: String) -> Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
  raw_counts_tag(value, api, Bool.pick(U32, String.eq(api, "cloudflare"), 1, Bool.pick(U32, String.eq(api, "vercel-evaluate"), 2, Bool.pick(U32, String.eq(api, "google"), 3, Bool.pick(U32, String.eq(api, "anthropic"), 4, Bool.pick(U32, String.eq(api, "system-one"), 5, Bool.pick(U32, String.eq(api, "llama-system-one"), 6, Bool.pick(U32, String.eq(api, "openai-decisions"), 7, 0))))))))

def raw_usage(text: String, api: String) -> Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
  do Result<&1, &1, Error, Maybe<&1, Nat & Nat>>:
    +value : J.JSON <- Codec.read_with_limit(text, bytes_max())
    fields : List<&2, J.JSON> <- W.object(value)
    raw_counts(value, api)

def null_default(value: Maybe<&2, J.JSON>) -> J.JSON:
  match value:
    case None{}: J.Null{}
    case Some{v}: v

def normalized_usage(value: Maybe<&2, J.JSON>, +i: String, +o: String) -> Result<&1, &1, Error, J.JSON>:
  match value:
    case None{}: Done{J.Obj{[J.Member{"input_tokens", J.Null{}}, J.Member{"output_tokens", J.Null{}}]}}
    case Some{J.Null{}}: Done{J.Obj{[J.Member{"input_tokens", J.Null{}}, J.Member{"output_tokens", J.Null{}}]}}
    case Some{+u}:
      do Result<&1, &1, Error, J.JSON>:
        checked : Maybe<&1, Nat & Nat> <- usage_counts(u, i, o)
        return J.Obj{[J.Member{"input_tokens", null_default(Codec.field(u, i))}, J.Member{"output_tokens", null_default(Codec.field(u, o))}]}

def response_usage_tag(value: J.JSON, api: String, tag: U32) -> Result<&1, &1, Error, J.JSON>:
  match tag:
    case 1: normalized_usage(Codec.field(value, "usage"), "inputTokens", "outputTokens")
    case unmatched: normalized_usage(Codec.field(value, "usage"), "input_tokens", "output_tokens")

def response_usage(value: J.JSON, +api: String) -> Result<&1, &1, Error, J.JSON>:
  response_usage_tag(value, api, Bool.pick(U32, String.eq(api, "vercel-evaluate"), 1, 0))

def success(value: J.JSON) -> Result<&1, &1, Error, Unit>:
  match value:
    case J.Boolean{True{}}: Done{Unit{}}
    case other: Fail{(22, "Cloudflare decision failed")}

def unwrap_tag(+value: J.JSON, api: String, tag: U32) -> Result<&1, &1, Error, J.JSON>:
  match tag:
    case 1:
      do Result<&1, &1, Error, J.JSON>:
        s : J.JSON <- W.need(value, "success")
        success(s)
        cloudflare_result(value)
    case 2: Generated.unwrap(value, "anthropic")
    case 3: Generated.unwrap(value, "google")
    case 4: Done{value}
    case 5: Done{value}
    case 6: Done{value}
    case 7: Done{value}
    case unmatched: Fail{(22, "unsupported decision API")}

def unwrap(+value: J.JSON, +api: String) -> Result<&1, &1, Error, J.JSON>:
  unwrap_tag(value, api, Bool.pick(U32, String.eq(api, "cloudflare"), 1, Bool.pick(U32, String.eq(api, "anthropic"), 2, Bool.pick(U32, String.eq(api, "google"), 3, Bool.pick(U32, String.eq(api, "system-one"), 4, Bool.pick(U32, String.eq(api, "llama-system-one"), 5, Bool.pick(U32, String.eq(api, "openai-decisions"), 6, Bool.pick(U32, String.eq(api, "vercel-evaluate"), 7, 0))))))))

def answer_map(items: List<&2, J.JSON>, +seen: List<&2, String>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match items:
    case Nil{}: Done{Nil{}}
    case Con{+a, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        n : J.JSON <- W.need(a, "name")
        +name : String <- W.string(n)
        Codec.guard(Bool.not(Codec.contains(seen, name)), "duplicate answer name")
        rest : List<&2, J.JSON> <- answer_map(tail, Con{name, seen})
        return Con{J.Member{name, a}, rest}

def response_answers_tag(value: J.JSON, api: String, tag: U32) -> Result<&1, &1, Error, J.JSON>:
  match tag:
    case 1:
      do Result<&1, &1, Error, J.JSON>:
        items : List<&2, J.JSON> <- W.array(value)
        fields : List<&2, J.JSON> <- answer_map(items, Nil{})
        return J.Obj{fields}
    case unmatched:
      do Result<&1, &1, Error, J.JSON>:
        fields : List<&2, J.JSON> <- W.object(value)
        return J.Obj{fields}

def response_answers(value: J.JSON, +api: String) -> Result<&1, &1, Error, J.JSON>:
  response_answers_tag(value, api, Bool.pick(U32, String.eq(api, "openai-decisions"), 1, 0))

def confidence(value: Maybe<&2, J.JSON>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match value:
    case None{}: Done{Nil{}}
    case Some{+v}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        checked : W.Decimal <- W.probability(v)
        return [J.Member{"confidence", v}]

def distribution_key_tag(value: J.JSON, k: String, tag: U32) -> Result<&1, &1, Error, String>:
  match tag:
    case 1:
      do Result<&1, &1, Error, String>:
        index : Nat <- W.scalar(value, 0n, 9n)
        return Nat.show(index)
    case unmatched: W.string(value)

# Use each row's value, never its position or label. Retain probability lexemes.
def distribution_key(value: J.JSON, +k: String) -> Result<&1, &1, Error, String>:
  distribution_key_tag(value, k, Bool.pick(U32, String.eq(k, "score"), 1, 0))

def distribution_rows(items: List<&2, J.JSON>, +k: String, +seen: List<&2, String>) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match items:
    case Nil{}: Done{Nil{}}
    case Con{+row, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        v : J.JSON <- W.need(row, "value")
        +key : String <- distribution_key(v, k)
        Codec.guard(Bool.not(Codec.contains(seen, key)), "duplicate probability value")
        p : J.JSON <- W.need(row, "probability")
        rest : List<&2, J.JSON> <- distribution_rows(tail, k, Con{key, seen})
        return Con{J.Member{key, p}, rest}

def distribution_object_tag(value: J.JSON, k: String, api: String, tag: U32) -> Result<&1, &1, Error, J.JSON>:
  match tag:
    case 1:
      do Result<&1, &1, Error, J.JSON>:
        items : List<&2, J.JSON> <- W.array(value)
        fields : List<&2, J.JSON> <- distribution_rows(items, k, Nil{})
        return J.Obj{fields}
    case unmatched:
      do Result<&1, &1, Error, J.JSON>:
        fields : List<&2, J.JSON> <- W.object(value)
        return J.Obj{fields}

def distribution_object(value: J.JSON, k: String, +api: String) -> Result<&1, &1, Error, J.JSON>:
  distribution_object_tag(value, k, api, Bool.pick(U32, String.eq(api, "openai-decisions"), 1, 0))

def probabilities(value: Maybe<&2, J.JSON>, +expected: List<&2, J.JSON>, k: String, api: String) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match value:
    case None{}: Done{Nil{}}
    case Some{v}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        +p : J.JSON <- distribution_object(v, k, api)
        fields : List<&2, J.JSON> <- W.object(p)
        Codec.guard(Nat.is_eq(List.length(&2, J.JSON, fields), List.length(&2, J.JSON, expected)), "probability key count mismatch")
        +sum : W.Decimal <- W.probability_sum(expected, p, W.Decimal{0n, ""})
        Codec.guard(W.decimal_le(W.Decimal{0n, "98"}, sum) && W.decimal_le(sum, W.Decimal{1n, "02"}), "probability mass outside tolerance")
        rows : List<&2, J.JSON> <- W.ordered(expected, p)
        return [J.Member{"probabilities", J.Obj{rows}}]

def common(+answer: J.JSON, expected: List<&2, J.JSON>, k: String, api: String) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  do Result<&1, &1, Error, List<&2, J.JSON>>:
    c : List<&2, J.JSON> <- confidence(Codec.field(answer, "confidence"))
    p : List<&2, J.JSON> <- probabilities(Codec.field(answer, "probabilities"), expected, k, api)
    return List.append(&2, J.JSON, c, p)

def boolean_value_tag(answer: J.JSON, actual: String, tag: U32) -> Result<&1, &1, Error, J.JSON>:
  match tag:
    case 1: W.need(answer, "noul")
    case unmatched: W.need(answer, "probability")

def boolean_value(answer: J.JSON, +actual: String) -> Result<&1, &1, Error, J.JSON>:
  boolean_value_tag(answer, actual, Bool.pick(U32, String.eq(actual, "noul"), 1, 0))

def answer_kind_tag(k: String, q: J.JSON, +a: J.JSON, actual: String, api: String, tag: U32) -> Result<&1, &1, Error, J.JSON>:
  match tag:
    case 1:
      do Result<&1, &1, Error, J.JSON>:
        +p : J.JSON <- boolean_value(a, actual)
        checked : W.Decimal <- W.probability(p)
        extra : List<&2, J.JSON> <- confidence(Codec.field(a, "confidence"))
        return J.Obj{Con{J.Member{"type", J.Str{"boolean"}}, Con{J.Member{"probability", p}, extra}}}
    case 2:
      do Result<&1, &1, Error, J.JSON>:
        c : J.JSON <- W.need(q, "criteria")
        +expected : List<&2, J.JSON> <- W.object(c)
        +selected : J.JSON <- W.need(a, "choice")
        key : String <- W.string(selected)
        Codec.guard(W.named(expected, key), "unknown selected choice")
        extra : List<&2, J.JSON> <- common(a, expected, "choice", api)
        return J.Obj{Con{J.Member{"type", J.Str{"choice"}}, Con{J.Member{"choice", selected}, extra}}}
    case 3:
      do Result<&1, &1, Error, J.JSON>:
        c : J.JSON <- W.need(q, "criteria")
        +levels : List<&2, J.JSON> <- W.array(c)
        +expected : List<&2, J.JSON> = W.indexed(levels, 0n)
        +score : J.JSON <- W.need(a, "score")
        checked : W.Decimal <- W.decimal(score, Nat.sub(List.length(&2, J.JSON, levels), 1n))
        extra : List<&2, J.JSON> <- common(a, expected, "score", api)
        return J.Obj{Con{J.Member{"type", J.Str{"score"}}, Con{J.Member{"score", score}, Con{J.Member{"legend", J.Obj{expected}}, extra}}}}
    case unmatched: Fail{(22, "unknown answer type")}

def answer_kind(+k: String, q: J.JSON, +a: J.JSON, actual: String, api: String) -> Result<&1, &1, Error, J.JSON>:
  answer_kind_tag(k, q, a, actual, api, Bool.pick(U32, String.eq(k, "boolean"), 1, Bool.pick(U32, String.eq(k, "choice"), 2, Bool.pick(U32, String.eq(k, "score"), 3, 0))))

def answer_checked_tag(+q: J.JSON, a: J.JSON, +actual: String, api: String, tag: U32) -> Result<&1, &1, Error, J.JSON>:
  match tag:
    case 1: Done{a}
    case unmatched:
      do Result<&1, &1, Error, J.JSON>:
        t : J.JSON <- W.need(q, "type")
        type_text : String <- W.string(t)
        +k : String = kind(type_text)
        Codec.guard(String.eq(k, kind(actual)), "answer type mismatch")
        answer_kind(k, q, a, actual, api)

def answer_checked(+q: J.JSON, a: J.JSON, +actual: String, api: String) -> Result<&1, &1, Error, J.JSON>:
  answer_checked_tag(q, a, actual, api, Bool.pick(U32, String.eq(actual, "refusal"), 1, 0))

def answer(q: J.JSON, +a: J.JSON, api: String) -> Result<&1, &1, Error, J.JSON>:
  do Result<&1, &1, Error, J.JSON>:
    fields : List<&2, J.JSON> <- W.object(a)
    t : J.JSON <- W.need(a, "type")
    actual : String <- W.string(t)
    answer_checked(q, a, actual, api)

def answers(qs: List<&2, J.JSON>, +actual: J.JSON, +api: String) -> Result<&1, &1, Error, List<&2, J.JSON>>:
  match qs:
    case Nil{}: Done{Nil{}}
    case Con{J.Member{+id, q}, tail}:
      do Result<&1, &1, Error, List<&2, J.JSON>>:
        raw : J.JSON <- W.need(actual, id)
        safe : J.JSON <- answer(q, raw, api)
        rest : List<&2, J.JSON> <- answers(tail, actual, api)
        return Con{J.Member{id, safe}, rest}
    case other: Fail{(22, "invalid question object")}

def response_model(value: Maybe<&2, J.JSON>, +fallback: String) -> Result<&1, &1, Error, J.JSON>:
  match value:
    case None{}:
      do Result<&1, &1, Error, J.JSON>:
        optional_model(Some{J.Str{fallback}})
        return J.Str{fallback}
    case Some{+v}:
      do Result<&1, &1, Error, J.JSON>:
        optional_model(Some{v})
        return v

def provenance_tag(api: String, tag: U32) -> String:
  match tag:
    case 1: "generated"
    case 2: "generated"
    case unmatched: "native"

def provenance(+api: String) -> String:
  provenance_tag(api, Bool.pick(U32, String.eq(api, "anthropic"), 1, Bool.pick(U32, String.eq(api, "google"), 2, 0)))

def refusal_answers(qs: List<&2, J.JSON>, +reason: J.JSON) -> List<&2, J.JSON>:
  match qs:
    case Nil{}: Nil{}
    case Con{J.Member{id, q}, tail}:
      Con{J.Member{id, J.Obj{[J.Member{"type", J.Str{"refusal"}}, J.Member{"reason", reason}]}}, refusal_answers(tail, reason)}
    case other: Nil{}

def with_refusal(actual: J.JSON, qs: List<&2, J.JSON>, refusal: Maybe<&2, J.JSON>, +api: String) -> Result<&1, &1, Error, J.JSON>:
  match refusal:
    case None{}: response_answers(actual, api)
    case Some{+reason}:
      do Result<&1, &1, Error, J.JSON>:
        Codec.guard(Codec.contains(["anthropic", "google"], api), "unexpected global refusal")
        message : String <- W.string(reason)
        fields : List<&2, J.JSON> <- W.object(actual)
        Codec.guard(Nat.is_eq(List.length(&2, J.JSON, fields), 0n), "ambiguous global refusal")
        return J.Obj{refusal_answers(qs, reason)}

def available_answers(+value: J.JSON, qs: List<&2, J.JSON>, api: String) -> Result<&1, &1, Error, J.JSON>:
  do Result<&1, &1, Error, J.JSON>:
    actual : J.JSON <- W.need(value, "answers")
    with_refusal(actual, qs, Codec.field(value, "refusal"), api)

# Validate the complete serialized envelope too, including rawJson escaping overhead.
def bounded(+value: J.JSON) -> Result<&1, &1, Error, J.JSON>:
  do Result<&1, &1, Error, J.JSON>:
    encoded : String <- Codec.encode_with_limit(value, bytes_max())
    return value

def reply(+text: String, req: J.JSON, +provider: String, +api: String, model: String) -> Result<&1, &1, Error, J.JSON>:
  do Result<&1, &1, Error, J.JSON>:
    checked : J.JSON <- validate_request(req)
    Codec.guard(identifier(provider, 128n), "invalid resolved provider")
    +raw : J.JSON <- Codec.read_with_limit(text, bytes_max())
    +value : J.JSON <- unwrap(raw, api)
    usage : J.JSON <- response_usage(value, api)
    returned_model : J.JSON <- response_model(Codec.field(value, "model"), model)
    qs : J.JSON <- W.need(checked, "questions")
    +qfields : List<&2, J.JSON> <- W.object(qs)
    +actual : J.JSON <- available_answers(value, qfields, api)
    afields : List<&2, J.JSON> <- W.object(actual)
    Codec.guard(Nat.is_eq(List.length(&2, J.JSON, qfields), List.length(&2, J.JSON, afields)), "answer key count mismatch")
    safe : List<&2, J.JSON> <- answers(qfields, actual, api)
    bounded(J.Obj{[
      J.Member{"provider", J.Str{provider}},
      J.Member{"api", J.Str{api}},
      J.Member{"model", returned_model},
      J.Member{"answers", J.Obj{safe}},
      J.Member{"usage", usage},
      J.Member{"provenance", J.Obj{[J.Member{"kind", J.Str{provenance(api)}}]}},
      J.Member{"raw", raw},
      J.Member{"rawJson", J.Str{text}},
    ]})
