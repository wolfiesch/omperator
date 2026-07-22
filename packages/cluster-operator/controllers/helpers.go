package controllers

import (
	"crypto/sha256"
	"encoding/hex"
	"reflect"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
)

const (
	ReasonStorageClassNotFound = "StorageClassNotFound"
	ReasonStorageClassNotRWX   = "StorageClassNotRWX"
	ReasonStorageClassMismatch = "StorageClassMismatch"
	ReasonStorageReady         = "StorageClassSupportsRWX"
)

func WorkspacePVCName(workspace *clusterv1alpha1.T4Workspace) string {
	return stableName("t4-ws-", workspace.Name, workspace.UID)
}

func SessionPodName(session *clusterv1alpha1.T4Session) string {
	return stableName("t4-session-", session.Name, session.UID)
}

func SessionServiceName(session *clusterv1alpha1.T4Session) string {
	return stableName("t4-session-", session.Name, session.UID)
}

func stableName(prefix, name string, uid types.UID) string {
	identity := name + ":" + string(uid)
	sum := sha256.Sum256([]byte(identity))
	suffix := hex.EncodeToString(sum[:6])
	var body strings.Builder
	body.Grow(len(name))
	lastWasSeparator := false
	for i := range len(name) {
		character := name[i]
		if character >= 'A' && character <= 'Z' {
			character += 'a' - 'A'
		}
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			body.WriteByte(character)
			lastWasSeparator = false
		} else if body.Len() > 0 && !lastWasSeparator {
			body.WriteByte('-')
			lastWasSeparator = true
		}
	}
	name = strings.Trim(body.String(), "-")
	maxName := 63 - len(prefix) - 1 - len(suffix)
	if len(name) > maxName {
		name = strings.TrimRight(name[:maxName], "-")
	}
	if name == "" {
		name = "resource"
	}
	return prefix + name + "-" + suffix
}

func storageClassAllowsRWX(annotations map[string]string) bool {
	for _, mode := range strings.Split(annotations[clusterv1alpha1.RWXStorageClassAnnotation], ",") {
		if strings.TrimSpace(mode) == string(corev1.ReadWriteMany) {
			return true
		}
	}
	return false
}

func pvcHasRWX(pvc *corev1.PersistentVolumeClaim) bool {
	for _, mode := range pvc.Spec.AccessModes {
		if mode == corev1.ReadWriteMany {
			return true
		}
	}
	return false
}

func pvcStorageClassName(pvc *corev1.PersistentVolumeClaim) string {
	if pvc.Spec.StorageClassName == nil {
		return ""
	}
	return *pvc.Spec.StorageClassName
}

func hasString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func removeString(values []string, unwanted string) []string {
	result := values[:0]
	for _, value := range values {
		if value != unwanted {
			result = append(result, value)
		}
	}
	return result
}

func condition(conditionType string, status metav1.ConditionStatus, reason, message string, generation int64) metav1.Condition {
	return metav1.Condition{
		Type: conditionType, Status: status, Reason: reason, Message: message,
		ObservedGeneration: generation, LastTransitionTime: metav1.NewTime(time.Now().UTC()),
	}
}

func objectChanged(before, after client.Object) bool {
	return !reflect.DeepEqual(before, after)
}
