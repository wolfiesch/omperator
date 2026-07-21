{{- define "t4-cluster.name" -}}
t4-cluster
{{- end -}}

{{- define "t4-cluster.fullname" -}}
{{- if contains "t4-cluster" .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-t4-cluster" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "t4-cluster.suffixedName" -}}
{{- $suffix := .suffix -}}
{{- $maxBaseLength := sub 62 (len $suffix) | int -}}
{{- $base := include "t4-cluster.fullname" .context | trunc $maxBaseLength | trimSuffix "-" -}}
{{- printf "%s-%s" $base $suffix -}}
{{- end -}}

{{- define "t4-cluster.labels" -}}
app.kubernetes.io/name: {{ include "t4-cluster.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/part-of: "t4-cluster"
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{- end -}}

{{- define "t4-cluster.selectorLabels" -}}
app.kubernetes.io/name: {{ include "t4-cluster.name" . | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{- define "t4-cluster.image" -}}
{{- printf "%s@%s" .repository .digest -}}
{{- end -}}
